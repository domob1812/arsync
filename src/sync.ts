import { SyncDB } from './db';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { driveDecrypt, fileDecrypt, deriveFileKey, JWKWallet, ASCENDING_ORDER } from 'ardrive-core-js';
import { setupDriveKey } from './utils';
import { gqlGateway, dataGateway } from './gateways';

export async function runSync(db: SyncDB, askPassword: () => Promise<string | null>, debug = false) {
    const driveId = await db.getConfig('drive_id');
    let walletPath = await db.getConfig('wallet_path');

    if (!driveId) throw new Error('No drive_id found in config. Did you run checkout?');

    console.log(`Starting sync for Drive: ${driveId}...`);
    if (debug) console.log('[DEBUG] Debug mode enabled.');

    // --- Preflight: verify drive privacy vs. wallet availability ---
    //
    // Fetch the root drive entity (oldest transaction with Entity-Type=drive
    // for this Drive-Id) and inspect its Drive-Privacy tag.  We do this before
    // attempting decryption so that a missing wallet produces a clear error
    // message instead of silently storing '[Encrypted - No Key]' for every
    // entity in the drive.
    {
        const driveCheckQuery = {
            query: `{
                transactions(
                    tags: [
                        { name: "Drive-Id", values: ["${driveId}"] }
                        { name: "Entity-Type", values: ["drive"] }
                    ]
                    sort: ${ASCENDING_ORDER}
                    first: 1
                ) {
                    edges {
                        node {
                            tags { name value }
                        }
                    }
                }
            }`
        };

        const driveCheckResult = await gqlGateway.gqlRequest(driveCheckQuery);

        if (driveCheckResult.edges.length === 0) {
            throw new Error(`Drive not found on the network: ${driveId}`);
        }

        const driveTags = driveCheckResult.edges[0].node.tags as { name: string; value: string }[];
        const drivePrivacy = driveTags.find(t => t.name === 'Drive-Privacy')?.value;

        if (drivePrivacy === 'private' && !walletPath) {
            throw new Error(
                `Drive ${driveId} is private but no wallet was provided.\n` +
                `Re-run checkout with the -w flag: arsync checkout ${driveId} -w /path/to/wallet.json .`
            );
        }

        if (drivePrivacy === 'public' && walletPath) {
            // Silently discard the stored wallet for public drives — no
            // decryption is needed. Printing a notice here would be
            // confusing on every `update` run when the wallet was only
            // provided once during the initial `checkout`.
            walletPath = null;
        }
    }
    // --- End preflight ---

    let driveKey: any;

    if (walletPath) {
        const jwk = JSON.parse(readFileSync(walletPath, 'utf8'));
        const wallet = new JWKWallet(jwk);

        driveKey = await setupDriveKey(wallet, driveId, askPassword);
    }

    let hasNextPage = true;
    let cursor = await db.getConfig('last_cursor') || undefined;
    let totalFetched = 0;
    let totalSkipped = 0;

    while (hasNextPage) {
        // We craft our own paginated query string rather than using buildQuery(),
        // because buildQuery() has two distinct modes:
        //   - cursor === undefined  → "single result" mode (first:1, no pageInfo block)
        //   - cursor !== undefined  → "paginated" mode (first:100, includes pageInfo)
        // Our initial fetch has no cursor (undefined), which would silently trigger
        // single-result mode, omit pageInfo from the response, and crash on
        // gqlResult.pageInfo.hasNextPage.
        //
        // We still route through gqlGateway.gqlRequest() to get exponential
        // back-off retries and rate-limit throttling for free.
        const query = {
            query: `{
                transactions(
                    tags: [{ name: "Drive-Id", values: ["${driveId}"] }]
                    sort: ${ASCENDING_ORDER}
                    first: 100
                    ${cursor ? `after: "${cursor}"` : ''}
                ) {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            id
                            tags { name value }
                        }
                    }
                }
            }`
        };

        console.log(`Fetching next batch from GraphQL... ${cursor ? `(Cursor: ${cursor})` : '(from beginning)'}`);

        // gqlRequest() posts to .../graphql on the gateway endpoint, with
        // built-in exponential back-off retries on failure.
        const gqlResult = await gqlGateway.gqlRequest(query);

        hasNextPage = gqlResult.pageInfo.hasNextPage;
        const edges = gqlResult.edges;

        if (debug) {
            console.log(`[DEBUG] Page returned ${edges.length} edges. hasNextPage=${hasNextPage}`);
        }

        if (edges.length === 0) {
            console.log('No new transactions found.');
            break;
        }

        for (const edge of edges) {
            const txId = edge.node.id;
            const tags = edge.node.tags as { name: string; value: string }[];

            const getTag = (name: string) => tags.find(t => t.name === name)?.value;

            const entityType = getTag('Entity-Type');
            const entityId = getTag('File-Id') || getTag('Folder-Id') || getTag('Drive-Id');
            const parentFolderId = getTag('Parent-Folder-Id') || null;
            const unixTimeStr = getTag('Unix-Time');
            const unixTime = unixTimeStr ? parseInt(unixTimeStr, 10) : 0;
            const isPrivate = getTag('Cipher-IV') !== undefined;
            // Restore any `+` characters that were corrupted to spaces in the
            // Cipher-IV tag value before passing it to Buffer.from(cipherIV, 'base64').
            //
            // `+` is a valid base64 alphabet character.  Arweave GQL tag values for
            // transactions written by early clients (e.g. ArDrive-Desktop 0.1.0,
            // circa 2021) have this character returned as a space by the gateway,
            // most likely because the tag was stored or retrieved through a code path
            // that applied URL/form-data encoding (where `+` encodes a space).
            //
            // A correct AES-256-GCM IV is exactly 12 bytes, which base64-encodes to
            // exactly 16 characters.  The corrupted IV "Hv CM2hAGbaQa83A" is 17
            // characters.  Node.js Buffer.from(str, 'base64') silently IGNORES
            // non-base64 characters (spaces are not in the base64 alphabet), so it
            // decodes only the 15 remaining characters → 11 bytes.  A 11-byte IV
            // causes AES-256-GCM auth-tag verification to fail, and fileDecrypt()
            // returns the 'Error' sentinel.
            //
            // Replacing spaces with `+` restores the original 16-character string
            // "Hv+CM2hAGbaQa83A" → 12 bytes → correct IV.  This is always safe
            // because a space can never appear in a legitimately base64-encoded IV.
            const cipherIv = getTag('Cipher-IV')?.replace(/ /g, '+') ?? undefined;
            const cipher = getTag('Cipher');

            if (debug) {
                console.log(`[DEBUG TX] id=${txId} entityType=${entityType ?? '(none)'} entityId=${entityId ?? '(none)'} unixTime=${unixTime}`);
            }

            if (!entityId || !entityType) {
                // Missing core ArFS tags — permanently malformed/non-ArFS transaction.
                // Log the full tag set so we can diagnose if something valid is being
                // incorrectly skipped (e.g. a tag-name variation from an old client).
                console.warn(`[SKIP] tx=${txId} reason=missing_arfs_tags tags=${JSON.stringify(tags)}`);
                totalSkipped++;
                cursor = edge.cursor;
                await db.setConfig('last_cursor', cursor);
                continue;
            }

            let rawData: Buffer;

            try {
                // getTxData() fetches from ${dataGateway}/${txId} — the correct
                // root-path that gateways use to resolve both L1 and ANS-104 bundled
                // data items. It also reads from/writes to ArFSMetadataCache on disk,
                // so subsequent runs skip the network entirely for already-seen txs.
                rawData = await dataGateway.getTxData(txId as any);
            } catch (dataErr: any) {
                // Network/gateway failure — TRANSIENT. Abort without advancing
                // the cursor so the next run will retry this transaction.
                console.error(`\n[ABORT] Transient error fetching payload for tx=${txId} entityType=${entityType} entityId=${entityId}`);
                console.error(`Error details: ${dataErr.message}`);
                throw dataErr;
            }

            let parsedMeta: any = {};

            try {
                if (isPrivate && driveKey && cipherIv) {
                    try {
                        // ArFS encryption model for metadata transactions:
                        //
                        //   drive metadata  → driveEncrypt(driveKey)     → decrypt with driveDecrypt(driveKey)
                        //   folder metadata → fileEncrypt(driveKey)      → decrypt with fileDecrypt(driveKey)
                        //   file metadata   → fileEncrypt(fileKey)        → decrypt with fileDecrypt(fileKey)
                        //                     where fileKey = deriveFileKey(fileId, driveKey)
                        //
                        // driveEncrypt and fileEncrypt both use AES-256-GCM with the same
                        // algorithm and tag length, so driveDecrypt and fileDecrypt are
                        // mechanically identical — the only difference is which key is used.
                        // Using the wrong key causes the GCM auth tag check to fail with
                        // "Unsupported state or unable to authenticate data".
                        //
                        // Additionally, the old ardrive-sync app used AES-256-CTR for some
                        // transactions. CTR is a stream cipher with NO auth tag, so GCM
                        // decryption always fails on CTR data. We detect this via the
                        // `Cipher` GQL tag and handle it separately.
                        let decryptedBuffer: Buffer;
                        if (cipher === 'AES256-CTR') {
                            // Legacy AES-256-CTR: stream cipher, 16-byte IV, no auth tag.
                            // The key to use still follows the same entity-type rules above,
                            // but since CTR predates per-file keys, all CTR metadata used
                            // the drive key directly.
                            const iv = Buffer.from(cipherIv, 'base64');
                            const decipher = crypto.createDecipheriv('aes-256-ctr', driveKey.keyData, iv);
                            decryptedBuffer = Buffer.concat([decipher.update(rawData), decipher.final()]);
                        } else if (entityType === 'file') {
                            // File metadata is encrypted with the per-file key derived
                            // from the drive key + file ID.
                            const fileKey = await deriveFileKey(entityId, driveKey);
                            decryptedBuffer = Buffer.from(await fileDecrypt(cipherIv, fileKey, rawData));
                            // fileDecrypt() swallows errors and returns Buffer('Error') instead
                            // of throwing — check for that sentinel value explicitly.
                            if (decryptedBuffer.toString('ascii') === 'Error') {
                                throw new Error('fileDecrypt returned Error sentinel (wrong key or corrupted data)');
                            }
                        } else {
                            // Drive and folder metadata: the official ardrive-core-js
                            // ArFSPrivateFolderBuilder.buildEntity() calls fileDecrypt(cipherIV,
                            // driveKey, data) — NOT driveDecrypt().  Both functions use identical
                            // AES-256-GCM logic internally, but driveDecrypt() THROWS on auth-tag
                            // failure while fileDecrypt() swallows the error and returns the
                            // 'Error' sentinel string.  Using driveDecrypt() here caused any
                            // folder with a subtly malformed IV to abort the entire sync rather
                            // than be handled gracefully.  We mirror the official library exactly.
                            decryptedBuffer = Buffer.from(await fileDecrypt(cipherIv, driveKey, rawData));
                            if (decryptedBuffer.toString('ascii') === 'Error') {
                                throw new Error('fileDecrypt returned Error sentinel for folder/drive (wrong key or corrupted data)');
                            }
                        }
                        parsedMeta = JSON.parse(decryptedBuffer.toString('utf8'));
                    } catch (e) {
                        // Decryption failed — skip regardless of entity type.
                        // We do not insert placeholder records: a bogus name in the
                        // DB is worse than a missing entry because it can mislead
                        // downstream commands (ls, download) into believing the
                        // entity is known and valid.
                        console.warn(`[SKIP] tx=${txId} entityType=${entityType} entityId=${entityId} reason=decrypt_failed error=${e}`);
                        totalSkipped++;
                        cursor = edge.cursor;
                        await db.setConfig('last_cursor', cursor);
                        continue;
                    }
                } else if (isPrivate) {
                    // Private but no key available for this session.
                    parsedMeta = { name: '[Encrypted - No Key]' };
                } else {
                    parsedMeta = JSON.parse(rawData.toString('utf8'));
                }
            } catch (parseErr: any) {
                // JSON.parse failed on a public transaction — PERMANENT (malformed data).
                console.warn(`[SKIP] tx=${txId} entityType=${entityType} entityId=${entityId} reason=json_parse_failed error=${parseErr.message}`);
                totalSkipped++;
                cursor = edge.cursor;
                await db.setConfig('last_cursor', cursor);
                continue;
            }

            // Upsert into the local SQLite database.
            await db.upsertEntity({
                entity_id: entityId,
                type: entityType,
                name: parsedMeta.name || 'Unknown',
                parent_folder_id: parentFolderId,
                data_tx_id: parsedMeta.dataTxId || null,
                size: parsedMeta.size || null,
                last_modified: parsedMeta.lastModifiedDate || null,
                metadata_tx_id: txId,
                unix_time: unixTime
            });

            if (debug) {
                console.log(`[DEBUG OK] entityId=${entityId} entityType=${entityType} name="${parsedMeta.name ?? ''}" tx=${txId}`);
            }

            totalFetched++;
            cursor = edge.cursor;
            await db.setConfig('last_cursor', cursor);
        }

        console.log(`Synced ${totalFetched} entities so far (${totalSkipped} skipped)...`);
    }

    console.log(`Sync complete! ${totalFetched} new/updated entities processed, ${totalSkipped} skipped.`);
}
