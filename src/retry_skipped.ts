import { readFileSync } from 'fs';
import crypto from 'crypto';
import { fileDecrypt, deriveFileKey, JWKWallet } from 'ardrive-core-js';
import { SyncDB } from './db';
import { setupDriveKey } from './utils';
import { dataGateway } from './gateways';

// ---------------------------------------------------------------------------
// Error classification (mirrors sync.ts)
// ---------------------------------------------------------------------------

function classifyFetchError(err: any): { failType: 'transient' | 'missing'; httpStatus: number | null } {
    const status: number | null =
        err?.response?.status ??
        err?.status ??
        null;
    if (status === 404) return { failType: 'missing', httpStatus: 404 };
    if (status !== null && status >= 400 && status < 500) return { failType: 'missing', httpStatus: status };
    return { failType: 'transient', httpStatus: status };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runRetrySkipped(
    db: SyncDB,
    askPassword: () => Promise<string | null>
): Promise<void> {
    const driveId = await db.getConfig('drive_id');
    if (!driveId) throw new Error('No drive_id in config. Did you run checkout?');

    const rows = await db.getFailedFetches('all');

    if (rows.length === 0) {
        console.log('No failed fetches recorded. Nothing to retry.');
        return;
    }

    console.log(`Retrying ${rows.length} previously-failed transaction(s)...\n`);

    // -----------------------------------------------------------------------
    // Derive drive key once if this is a private drive
    // -----------------------------------------------------------------------

    const walletPath = await db.getConfig('wallet_path');
    let driveKey: any;

    if (walletPath) {
        const jwk = JSON.parse(readFileSync(walletPath, 'utf8'));
        const wallet = new JWKWallet(jwk);
        driveKey = await setupDriveKey(wallet, driveId, askPassword);
    }

    // -----------------------------------------------------------------------
    // Retry loop
    // -----------------------------------------------------------------------

    let recovered = 0;
    let stillFailing = 0;

    for (const row of rows) {
        const txId: string        = row.metadata_tx_id;
        const entityId: string    = row.entity_id;
        const entityType: string  = row.entity_type;
        const blockHeight: number = row.block_height;
        const unixTime: number    = row.unix_time;
        const parentFolderId: string | null = row.parent_folder_id;

        process.stdout.write(`  tx=${txId.substring(0, 16)}... retries=${row.retry_count} `);

        // ----------------------------------------------------------------
        // Attempt payload fetch
        // ----------------------------------------------------------------

        let rawData: Buffer;

        try {
            rawData = await dataGateway.getTxData(txId as any);
        } catch (fetchErr: any) {
            const { failType, httpStatus } = classifyFetchError(fetchErr);
            process.stdout.write(`→ FAILED (http=${httpStatus ?? 'none'}): ${fetchErr.message}\n`);

            await db.recordFailedFetch({
                metadata_tx_id:   txId,
                entity_id:        entityId,
                entity_type:      entityType,
                block_height:     blockHeight,
                unix_time:        unixTime,
                parent_folder_id: parentFolderId,
                gql_cursor:       row.gql_cursor,
                fail_type:        failType,
                http_status:      httpStatus,
                error_message:    fetchErr.message ?? String(fetchErr)
            });

            stillFailing++;
            continue;
        }

        // ----------------------------------------------------------------
        // Attempt decrypt + parse
        // ----------------------------------------------------------------

        let parsedMeta: any;

        try {
            // Determine encryption from the stored entity_type and the
            // presence of a Cipher-IV.  We re-read it from GQL tags stored
            // in the row; if absent we treat the payload as plaintext.
            //
            // Note: the Cipher-IV is NOT stored in failed_fetches (only the
            // metadata_tx_id is stored).  For the retry we rely on the raw
            // payload itself: if decryption is needed but we have no drive key
            // the decrypt block below will throw and we'll record the failure.

            const isEncrypted = driveKey !== undefined;

            if (isEncrypted) {
                // We need the Cipher-IV from the metadata transaction tags.
                // Rather than re-hitting GQL, we attempt to derive it from
                // the raw bytes by trying decryption directly.  If we don't
                // have it the payload cannot be decrypted — record as failed.
                //
                // In practice, if this is a retry it means the payload was
                // previously fetched successfully (we have rawData), but
                // the decrypt will need the IV.  The IV is a GQL tag on the
                // metadata transaction, not embedded in the payload itself.
                //
                // For simplicity on retry: re-fetch the tags from GQL inline.
                const { buildQuery } = await import('ardrive-core-js');
                const { gqlGateway } = await import('./gateways');

                const tagQuery = buildQuery({ tags: [], ids: [txId as any] });
                const tagResult = await gqlGateway.gqlRequest(tagQuery);

                if (!tagResult.edges || tagResult.edges.length === 0) {
                    throw new Error('Could not re-fetch GQL tags for decryption.');
                }

                const tags = tagResult.edges[0].node.tags as { name: string; value: string }[];
                const getTag = (name: string) => tags.find((t: any) => t.name === name)?.value;

                const rawCipherIv = getTag('Cipher-IV');
                if (!rawCipherIv) {
                    throw new Error('No Cipher-IV tag on metadata transaction — cannot decrypt.');
                }
                // Apply the same space→+ base64 correction as sync.ts.
                const cipherIv = rawCipherIv.replace(/ /g, '+');
                const cipher   = getTag('Cipher');

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
                        throw new Error('fileDecrypt returned Error sentinel for folder/drive');
                    }
                }

                parsedMeta = JSON.parse(decryptedBuffer.toString('utf8'));
            } else {
                parsedMeta = JSON.parse(rawData.toString('utf8'));
            }
        } catch (parseErr: any) {
            process.stdout.write(`→ FAILED (parse/decrypt): ${parseErr.message}\n`);

            await db.recordFailedFetch({
                metadata_tx_id:   txId,
                entity_id:        entityId,
                entity_type:      entityType,
                block_height:     blockHeight,
                unix_time:        unixTime,
                parent_folder_id: parentFolderId,
                gql_cursor:       row.gql_cursor,
                fail_type:        'transient',   // parse failure is unexpected; keep retrying
                http_status:      null,
                error_message:    parseErr.message ?? String(parseErr)
            });

            stillFailing++;
            continue;
        }

        // ----------------------------------------------------------------
        // Success — upsert entity and clear the failure record
        // ----------------------------------------------------------------

        await db.upsertEntity({
            entity_id:        entityId,
            type:             entityType,
            name:             parsedMeta.name || 'Unknown',
            parent_folder_id: parentFolderId,
            data_tx_id:       parsedMeta.dataTxId   || null,
            size:             parsedMeta.size        || null,
            last_modified:    parsedMeta.lastModifiedDate || null,
            metadata_tx_id:   txId,
            block_height:     blockHeight,
            unix_time:        unixTime
        });

        await db.clearFailedFetch(txId);

        process.stdout.write(`→ OK  (name="${parsedMeta.name ?? ''}")\n`);
        recovered++;
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------

    console.log('');
    console.log(`Retry complete. Recovered: ${recovered}, Still failing: ${stillFailing}.`);

    if (recovered > 0) {
        // Check whether recovery resolved any orphan situations.
        const orphanCount = await db.countOrphanedEntities(driveId);
        if (orphanCount === 0) {
            console.log('All previously-orphaned entities are now fully resolved.');
        } else {
            console.log(`Note: ${orphanCount} entity/entities still have unresolved parent folders.`);
            console.log('  Some parent folder transactions may still be failing.');
        }
    }

    if (stillFailing > 0) {
        console.log(`${stillFailing} transaction(s) are still failing.`);
        console.log('  Run "arsync retry-skipped" again later, or accept that the data may be permanently unavailable.');
    }
}
