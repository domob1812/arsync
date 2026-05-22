import { SyncDB } from './db';
import { readFileSync } from 'fs';
import crypto from 'crypto';
import { fileDecrypt, deriveFileKey, JWKWallet, ASCENDING_ORDER } from 'ardrive-core-js';
import { setupDriveKey } from './utils';
import { gqlGateway, dataGateway } from './gateways';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * After this many consecutive transient failures for the same transaction,
 * the entry is demoted from 'transient' to 'missing'.  This prevents a
 * single broken-but-indexed transaction from blocking every future sync run.
 */
const MAX_TRANSIENT_RETRIES = 5;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify a data-fetch error into 'transient' or 'missing' and extract the
 * HTTP status code when available.
 *
 * Rule of thumb:
 *   HTTP 404           → 'missing'  (gateway definitively has no data)
 *   HTTP 4xx (other)   → 'missing'  (client error — retrying won't help)
 *   HTTP 5xx           → 'transient' (server error — may recover)
 *   Network / timeout  → 'transient' (connectivity issue — may recover)
 */
function classifyFetchError(err: any): { failType: 'transient' | 'missing'; httpStatus: number | null } {
    // Axios wraps HTTP errors in err.response; some libraries surface err.status
    // directly.  Fall back to null if neither is present (pure network error).
    const status: number | null =
        err?.response?.status ??
        err?.status ??
        null;

    if (status === 404) {
        return { failType: 'missing', httpStatus: 404 };
    }

    if (status !== null && status >= 400 && status < 500) {
        // Other 4xx errors (403 Forbidden, 410 Gone, etc.) are also definitive:
        // the gateway understood the request and deliberately refused/cannot serve it.
        return { failType: 'missing', httpStatus: status };
    }

    // 5xx errors or pure network failures are treated as transient.
    return { failType: 'transient', httpStatus: status };
}

export async function runSync(db: SyncDB, askPassword: () => Promise<string | null>, debug = false) {
    const driveId = await db.getConfig('drive_id');
    let walletPath = await db.getConfig('wallet_path');

    if (!driveId) throw new Error('No drive_id found in config. Did you run checkout?');

    console.log(`Starting sync for Drive: ${driveId}...`);
    if (debug) console.log('[DEBUG] Debug mode enabled.');

    // -----------------------------------------------------------------------
    // Preflight: determine drive owner and privacy
    // -----------------------------------------------------------------------
    //
    // We fetch the very first transaction ever posted for this Drive-Id (sort
    // HEIGHT_ASC, first: 1).  This gives us two things:
    //
    //   1. The wallet address of the drive owner — stored once in config as
    //      `drive_owner` and used as an `owners` filter on all subsequent GQL
    //      queries.  This is a correctness requirement: anyone can post a
    //      transaction with an arbitrary Drive-Id tag, so without an owner
    //      filter a malicious actor could corrupt our local database by
    //      injecting fake metadata transactions.
    //
    //   2. The Drive-Privacy tag — used to determine whether decryption is
    //      needed and whether a wallet is required.
    //
    // We only need to make this query once; after the first run the owner is
    // cached in config and we skip the network call.

    let driveOwner = await db.getConfig('drive_owner');

    if (!driveOwner) {
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
                            owner { address }
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

        const firstNode = driveCheckResult.edges[0].node;
        driveOwner = firstNode.owner.address as string;
        await db.setConfig('drive_owner', driveOwner);

        const driveTags = firstNode.tags as { name: string; value: string }[];
        const drivePrivacy = driveTags.find(t => t.name === 'Drive-Privacy')?.value;

        if (drivePrivacy === 'private' && !walletPath) {
            throw new Error(
                `Drive ${driveId} is private but no wallet was provided.\n` +
                `Re-run checkout with the -w flag: arsync checkout ${driveId} -w /path/to/wallet.json .`
            );
        }

        if (drivePrivacy === 'public' && walletPath) {
            // Silently discard the stored wallet for public drives — no
            // decryption is needed.
            walletPath = null;
        }
    } else {
        // Owner already known from a previous run.  Still need to check
        // privacy/wallet consistency if a wallet path is stored.
        if (!walletPath) {
            // No wallet — assume public (or we'll fail at decryption time
            // with a clear error if the drive is actually private).
        }
    }

    console.log(`Drive owner: ${driveOwner}`);

    // -----------------------------------------------------------------------
    // Derive drive key (private drives only)
    // -----------------------------------------------------------------------

    let driveKey: any;

    if (walletPath) {
        const jwk = JSON.parse(readFileSync(walletPath, 'utf8'));
        const wallet = new JWKWallet(jwk);
        driveKey = await setupDriveKey(wallet, driveId, askPassword);
    }

    // -----------------------------------------------------------------------
    // Pre-flight: report any previously-recorded fetch failures
    // -----------------------------------------------------------------------
    //
    // We surface the count of known-failed transactions before starting the
    // main GQL walk so the user can see the state up-front.  Automatic retry
    // during `update` is intentionally NOT done here — run `arsync retry-skipped`
    // to explicitly retry them.

    const failCounts = await db.countFailedFetches();
    const totalFailed = failCounts.transient + failCounts.missing;
    if (totalFailed > 0) {
        console.log(`Note: ${totalFailed} previously-failed transaction(s) are recorded in the database.`);
        console.log('  Run "arsync retry-skipped" to attempt recovery.\n');
    }

    // -----------------------------------------------------------------------
    // Determine the minimum block height for this sync run
    // -----------------------------------------------------------------------
    //
    // `last_synced_block_height` is updated after every processed batch
    // (not just on clean completion) because we walk HEIGHT_ASC: every
    // batch is monotonically newer than the previous one, so the highest
    // block height in a batch is always safe to persist immediately.
    //
    // On an incremental update we pass `block: {min: N - 5}` to the GQL
    // query, where N is the last saved height.  The 5-block safety margin
    // guards against chain reorgs and the edge case where a single block
    // contains more transactions than one page: even if we only partially
    // processed a block before a previous abort, the cursor provides the
    // exact resume position, and the block filter ensures we skip the bulk
    // of already-processed history.  The upsert guard in the database
    // makes re-processing a handful of transactions at the boundary
    // perfectly safe.
    //
    // For the initial checkout there is no saved height, so no block filter
    // is applied and we walk the full history.

    const lastSyncedHeightStr = await db.getConfig('last_synced_block_height');
    const lastSyncedHeight = lastSyncedHeightStr ? parseInt(lastSyncedHeightStr, 10) : null;

    let minBlockHeight: number | null = null;
    if (lastSyncedHeight !== null) {
        minBlockHeight = Math.max(0, lastSyncedHeight - 5);
        console.log(`Incremental update from block height ${minBlockHeight} (last synced: ${lastSyncedHeight}).`);
    } else {
        console.log('Initial checkout — fetching full drive history.');
    }

    // -----------------------------------------------------------------------
    // Main paginated GQL walk (HEIGHT_ASC)
    // -----------------------------------------------------------------------

    let hasNextPage = true;
    const rawCursor = await db.getConfig('last_cursor');
    let cursor: string | undefined = rawCursor && rawCursor !== '' ? rawCursor : undefined;
    let totalFetched = 0;
    let totalSkipped = 0;

    while (hasNextPage) {
        // We craft the GQL query string manually rather than using the
        // ardrive-core-js buildQuery() helper because buildQuery() has two
        // distinct modes keyed on whether a cursor is present:
        //
        //   cursor === undefined  → "single result" mode (first:1, no pageInfo)
        //   cursor !== undefined  → "paginated" mode   (first:100, pageInfo)
        //
        // Our initial fetch has no cursor, which would silently trigger
        // single-result mode, omit the pageInfo block, and crash on
        // gqlResult.pageInfo.hasNextPage.
        //
        // We still route through gqlGateway.gqlRequest() so we get
        // exponential back-off retries and rate-limit throttling for free.
        //
        // The `owners` filter is a correctness requirement (see preflight
        // comment above).  The `block: {min: ...}` filter is a performance
        // optimisation for incremental updates — it lets the gateway skip
        // the bulk of already-processed history.
        const query = {
            query: `{
                transactions(
                    owners: ["${driveOwner}"]
                    tags: [{ name: "Drive-Id", values: ["${driveId}"] }]
                    sort: ${ASCENDING_ORDER}
                    first: 100
                    ${minBlockHeight !== null ? `block: {min: ${minBlockHeight}}` : ''}
                    ${cursor ? `after: "${cursor}"` : ''}
                ) {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            id
                            block { height }
                            tags { name value }
                        }
                    }
                }
            }`
        };

        console.log(`Fetching next batch from GraphQL...${cursor ? ` (cursor: ${cursor.substring(0, 12)}...)` : ' (from beginning)'}`);

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

        // Track the highest confirmed block height seen in this batch.
        // Pending (unconfirmed) transactions have block=null; we skip them
        // for the watermark since they don't yet have a stable height.
        let batchMaxHeight: number | null = null;

        for (const edge of edges) {
            const txId = edge.node.id;
            const blockHeight: number | null = edge.node.block?.height ?? null;
            const tags = edge.node.tags as { name: string; value: string }[];

            const getTag = (name: string) => tags.find(t => t.name === name)?.value;

            const entityType = getTag('Entity-Type');
            const entityId = getTag('File-Id') || getTag('Folder-Id') || getTag('Drive-Id');
            const parentFolderId = getTag('Parent-Folder-Id') || null;
            const unixTimeStr = getTag('Unix-Time');
            const unixTime = unixTimeStr ? parseInt(unixTimeStr, 10) : 0;
            const isPrivate = getTag('Cipher-IV') !== undefined;
            // Restore any `+` characters corrupted to spaces in the Cipher-IV
            // tag value.  See the long comment in the original sync.ts for the
            // full explanation; the short version is: early ArDrive clients
            // URL/form-encoded tag values, turning `+` (valid base64) into a
            // space.  Buffer.from(str, 'base64') silently drops spaces, giving
            // an 11-byte IV instead of 12, which breaks AES-256-GCM auth-tag
            // verification.  Spaces cannot appear in legitimate base64, so this
            // substitution is always safe.
            const cipherIv = getTag('Cipher-IV')?.replace(/ /g, '+') ?? undefined;
            const cipher = getTag('Cipher');

            if (debug) {
                console.log(`[DEBUG TX] id=${txId} height=${blockHeight ?? 'pending'} entityType=${entityType ?? '(none)'} entityId=${entityId ?? '(none)'} unixTime=${unixTime}`);
            }

            if (!entityId || !entityType) {
                console.warn(`[SKIP] tx=${txId} reason=missing_arfs_tags tags=${JSON.stringify(tags)}`);
                totalSkipped++;
                cursor = edge.cursor;
                await db.setConfig('last_cursor', cursor);
                continue;
            }

            // ------------------------------------------------------------------
            // Fetch metadata payload
            // ------------------------------------------------------------------

            let rawData: Buffer;

            try {
                // getTxData() fetches from <gateway>/<txId>, which resolves both
                // L1 and ANS-104 bundled data items.  It also reads from/writes
                // to the ardrive-core-js ArFSMetadataCache on disk, so payloads
                // already fetched once are served locally with no network I/O.
                rawData = await dataGateway.getTxData(txId as any);
            } catch (dataErr: any) {
                // The payload fetch failed.  Classify the error, record it in
                // failed_fetches, advance the cursor past this transaction, and
                // continue.  This keeps the sync moving even when a single
                // gateway permanently lacks data for a specific transaction.
                //
                // The cursor IS advanced here (unlike a hard abort) so that
                // repeated runs don't re-attempt this transaction indefinitely
                // during the normal GQL walk.  Use `arsync retry-skipped` to
                // explicitly retry recorded failures.
                const { failType, httpStatus } = classifyFetchError(dataErr);
                const existingRow = await db.getFailedFetches('all').then(
                    rows => rows.find(r => r.metadata_tx_id === txId)
                );
                const retryCount = existingRow ? existingRow.retry_count + 1 : 0;

                console.warn(`\n[SKIP] tx=${txId} entityType=${entityType ?? '?'} entityId=${entityId} reason=fetch_failed http=${httpStatus ?? 'none'} retries=${retryCount} error=${dataErr.message}`);

                await db.recordFailedFetch({
                    metadata_tx_id:   txId,
                    entity_id:        entityId,
                    entity_type:      entityType ?? null,
                    block_height:     blockHeight,
                    unix_time:        unixTime,
                    parent_folder_id: parentFolderId,
                    gql_cursor:       edge.cursor,
                    fail_type:        failType,
                    http_status:      httpStatus,
                    error_message:    dataErr.message ?? String(dataErr)
                });

                totalSkipped++;
                cursor = edge.cursor;
                await db.setConfig('last_cursor', cursor);
                if (blockHeight !== null && (batchMaxHeight === null || blockHeight > batchMaxHeight)) {
                    batchMaxHeight = blockHeight;
                }
                continue;
            }

            // ------------------------------------------------------------------
            // Decrypt / parse metadata payload
            // ------------------------------------------------------------------

            let parsedMeta: any = {};

            try {
                if (isPrivate && driveKey && cipherIv) {
                    try {
                        let decryptedBuffer: Buffer;

                        if (cipher === 'AES256-CTR') {
                            const iv = Buffer.from(cipherIv, 'base64');
                            const decipher = crypto.createDecipheriv('aes-256-ctr', driveKey.keyData, iv);
                            decryptedBuffer = Buffer.concat([decipher.update(rawData), decipher.final()]);
                        } else if (entityType === 'file') {
                            const fileKey = await deriveFileKey(entityId, driveKey);
                            decryptedBuffer = Buffer.from(await fileDecrypt(cipherIv, fileKey, rawData));
                            if (decryptedBuffer.toString('ascii') === 'Error') {
                                throw new Error('fileDecrypt returned Error sentinel (wrong key or corrupted data)');
                            }
                        } else {
                            decryptedBuffer = Buffer.from(await fileDecrypt(cipherIv, driveKey, rawData));
                            if (decryptedBuffer.toString('ascii') === 'Error') {
                                throw new Error('fileDecrypt returned Error sentinel for folder/drive (wrong key or corrupted data)');
                            }
                        }

                        parsedMeta = JSON.parse(decryptedBuffer.toString('utf8'));
                    } catch (e) {
                        console.warn(`[SKIP] tx=${txId} entityType=${entityType} entityId=${entityId} reason=decrypt_failed error=${e}`);
                        totalSkipped++;
                        cursor = edge.cursor;
                        await db.setConfig('last_cursor', cursor);
                        continue;
                    }
                } else if (isPrivate) {
                    parsedMeta = { name: '[Encrypted - No Key]' };
                } else {
                    parsedMeta = JSON.parse(rawData.toString('utf8'));
                }
            } catch (parseErr: any) {
                console.warn(`[SKIP] tx=${txId} entityType=${entityType} entityId=${entityId} reason=json_parse_failed error=${parseErr.message}`);
                totalSkipped++;
                cursor = edge.cursor;
                await db.setConfig('last_cursor', cursor);
                continue;
            }

            // ------------------------------------------------------------------
            // Upsert into the local SQLite database
            // ------------------------------------------------------------------

            await db.upsertEntity({
                entity_id: entityId,
                type: entityType,
                name: parsedMeta.name || 'Unknown',
                parent_folder_id: parentFolderId,
                data_tx_id: parsedMeta.dataTxId || null,
                size: parsedMeta.size || null,
                last_modified: parsedMeta.lastModifiedDate || null,
                metadata_tx_id: txId,
                // blockHeight is null for pending (unconfirmed) transactions.
                // We default to 0 so the upsert WHERE condition treats them as
                // the lowest possible priority; a confirmed revision in any
                // real block will always win over a pending one.
                block_height: blockHeight ?? 0,
                unix_time: unixTime
            });

            if (debug) {
                console.log(`[DEBUG OK] entityId=${entityId} entityType=${entityType} name="${parsedMeta.name ?? ''}" tx=${txId}`);
            }

            totalFetched++;
            cursor = edge.cursor;
            await db.setConfig('last_cursor', cursor);

            // Update the block height watermark for this transaction.
            if (blockHeight !== null) {
                if (batchMaxHeight === null || blockHeight > batchMaxHeight) {
                    batchMaxHeight = blockHeight;
                }
            }
        }

        // Persist the watermark after every batch.  Because we walk
        // HEIGHT_ASC, this value only ever moves forward.  Persisting
        // per-batch (rather than only on clean completion) means that an
        // aborted run still advances the watermark as far as possible,
        // making the next resume faster.
        if (batchMaxHeight !== null) {
            const currentHighStr = await db.getConfig('last_synced_block_height');
            const currentHigh = currentHighStr ? parseInt(currentHighStr, 10) : 0;
            if (batchMaxHeight > currentHigh) {
                await db.setConfig('last_synced_block_height', String(batchMaxHeight));
            }
        }

        console.log(`Synced ${totalFetched} entities so far (${totalSkipped} skipped)...`);
    }

    // Clear the cursor on clean completion so the next `arsync update`
    // starts fresh (relying solely on the block height filter).
    await db.setConfig('last_cursor', '');

    // Print a final summary of any fetch failures accumulated across all runs.
    const finalFailCounts = await db.countFailedFetches();
    const finalTotalFailed = finalFailCounts.transient + finalFailCounts.missing;
    console.log(`Sync complete! ${totalFetched} new/updated entities processed, ${totalSkipped} skipped.`);
    if (finalTotalFailed > 0) {
        console.log(`\nNote: ${finalTotalFailed} transaction(s) have recorded fetch failures (cumulative across all runs).`);
        console.log('  Run "arsync retry-skipped" to attempt recovery.');
    }
}
