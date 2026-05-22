import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SyncDB } from './db';
import { findProjectRoot, setupDriveKey } from './utils';
import { JWKWallet, deriveFileKey, fileDecrypt, buildQuery } from 'ardrive-core-js';
import { gqlGateway, dataGateway } from './gateways';

/**
 * Fetches the tags for a given transaction ID via GQL.
 *
 * We use GQL (not /tx/{txId}) because the latter returns 404 for ANS-104
 * bundled data items that have not yet been indexed at the base layer.
 * The shared gqlGateway (arweave.net) has authoritative coverage of both
 * L1 transactions and bundled data items.
 */
async function getTagsForTxId(txId: string): Promise<{ name: string; value: string }[]> {
    const query = buildQuery({ tags: [], ids: [txId as any] });
    const result = await gqlGateway.gqlRequest(query);
    if (!result.edges || result.edges.length === 0) {
        throw new Error(`No GQL result found for transaction ID: ${txId}`);
    }
    return result.edges[0].node.tags as { name: string; value: string }[];
}

export async function runDownload(targetPath: string, askPassword: () => Promise<string | null>) {
    const cwd = process.cwd();
    const resolvedPath = path.resolve(cwd, targetPath);

    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) {
        console.error("Error: Not inside an arsync project.");
        process.exit(1);
    }

    const relativePath = path.relative(projectRoot, resolvedPath);
    if (relativePath.startsWith('..')) {
        console.error("Error: Path is outside the arsync project.");
        process.exit(1);
    }

    const db = new SyncDB(projectRoot);
    const driveId = await db.getConfig('drive_id');
    const walletPath = await db.getConfig('wallet_path');
    if (!driveId) {
        console.error("Error: Project not fully checked out.");
        process.exit(1);
    }

    let driveKey: any;
    let wallet: JWKWallet | undefined;
    if (walletPath) {
        const jwk = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
        wallet = new JWKWallet(jwk);
    }

    // Resolve local path to ArDrive entity
    let currentId = await db.getRootFolderId(driveId);
    let currentType = 'folder';

    const parts = relativePath.split(path.sep).filter(p => p.length > 0);
    for (const part of parts) {
        if (!currentId || currentType !== 'folder') {
            console.error(`Error: Path component '${part}' not found or is not a folder in ArDrive.`);
            process.exit(1);
        }
        const children = await db.getChildren(currentId);
        const child = children.find(c => c.name === part);
        if (!child) {
            console.error(`Error: '${part}' not found in ArDrive.`);
            process.exit(1);
        }
        currentId = child.entity_id;
        currentType = child.type;
    }

    if (!currentId) {
        console.error("Error: Could not resolve target path.");
        process.exit(1);
    }

    // Collect all files and folders to download recursively
    const itemsToDownload: { entity: any, relPath: string }[] = [];

    async function collectItems(entityId: string, type: string, currentRelPath: string) {
        if (type === 'file') {
            const entity = await db.getEntity(entityId);
            if (entity) itemsToDownload.push({ entity, relPath: currentRelPath });
        } else if (type === 'folder') {
            const entity = await db.getEntity(entityId);
            // Push the folder itself so we can create it even if empty
            if (entity && currentRelPath !== '') {
                itemsToDownload.push({ entity, relPath: currentRelPath });
            }

            const children = await db.getChildren(entityId);
            for (const child of children) {
                await collectItems(child.entity_id, child.type, path.join(currentRelPath, child.name));
            }
        }
    }

    await collectItems(currentId, currentType, relativePath);

    // Warn about orphaned entities before starting the download so the user
    // knows upfront that some items are invisible to this run.
    const orphanCount = await db.countOrphanedEntities(driveId);
    if (orphanCount > 0) {
        console.warn(`Warning: ${orphanCount} entity/entities in the database have unresolved parent folders and will NOT be downloaded.`);
        console.warn(`         Run \`arsync retry-skipped\` to attempt recovery, then re-run download.`);
    }

    console.log(`Found ${itemsToDownload.length} item(s) in ArDrive subtree.`);

    let downloadedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const item of itemsToDownload) {
        const localFullPath = path.join(projectRoot, item.relPath);
        const entity = item.entity;

        if (fs.existsSync(localFullPath)) {
            skippedCount++;
            continue;
        }

        if (entity.type === 'folder') {
            console.log(`Creating folder ${item.relPath} ...`);
            fs.mkdirSync(localFullPath, { recursive: true });
            continue;
        }

        if (!entity.data_tx_id) {
            console.warn(`Skipping ${item.relPath} (no data_tx_id in local DB — sync may be incomplete).`);
            skippedCount++;
            continue;
        }

        console.log(`Downloading ${item.relPath} ...`);
        fs.mkdirSync(path.dirname(localFullPath), { recursive: true });

        try {
            // Fetch the metadata transaction's tags via GQL to check for Cipher-IV.
            // We use GQL (not /tx/{txId}) so this works for ANS-104 bundled items too.
            const metaTags = await getTagsForTxId(entity.metadata_tx_id);
            const getMetaTag = (name: string) => metaTags.find(t => t.name === name)?.value;
            const metaCipherIv = getMetaTag('Cipher-IV');

            // Fetch the actual file data payload.
            // getTxData() uses the root-path endpoint which correctly handles
            // both L1 and ANS-104 bundled data items, with retries and disk cache.
            let buffer = await dataGateway.getTxData(entity.data_tx_id as any);

            if (metaCipherIv) {
                // The file is encrypted. We need the drive key.
                if (!driveKey && wallet) {
                    driveKey = await setupDriveKey(wallet, driveId, askPassword);
                }

                if (!driveKey) {
                    throw new Error('Could not derive drive key to decrypt file.');
                }

                // The data transaction has its OWN Cipher-IV, separate from the
                // metadata transaction's Cipher-IV. Fetch it via GQL as well.
                const dataTags = await getTagsForTxId(entity.data_tx_id);
                const getDataTag = (name: string) => dataTags.find(t => t.name === name)?.value;

                // Apply the same space→+ correction as sync.ts: early ArDrive clients
                // stored base64 Cipher-IV values where '+' was corrupted to ' ' in GQL.
                const rawDataCipherIv = getDataTag('Cipher-IV');
                if (!rawDataCipherIv) {
                    throw new Error('Data transaction is missing Cipher-IV tag.');
                }
                const dataCipherIv = rawDataCipherIv.replace(/ /g, '+');

                // Derive the file-specific key and decrypt.
                const fileKey = await deriveFileKey(entity.entity_id, driveKey);
                const decrypted = Buffer.from(await fileDecrypt(dataCipherIv, fileKey, buffer));

                // fileDecrypt() swallows crypto errors and returns Buffer('Error')
                // instead of throwing.  Detect the sentinel explicitly so we never
                // write garbage to disk.
                if (decrypted.toString('ascii') === 'Error') {
                    throw new Error('fileDecrypt returned Error sentinel — wrong key or corrupted ciphertext.');
                }

                buffer = decrypted;
            }

            // Write decrypted (or plain) file to disk.
            fs.writeFileSync(localFullPath, buffer);

            // Compute SHA256 hash and record sync state in the database.
            // Store the data_tx_id so we can later detect cloud-side changes.
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const stats = fs.statSync(localFullPath);
            await db.updateSyncState(entity.entity_id, hash, stats.mtimeMs, stats.size, entity.data_tx_id);

            downloadedCount++;
        } catch (err: any) {
            console.error(`Failed to download ${item.relPath}: ${err.message}`);

            // Remove any partially-written file so that the next run retries it
            // instead of silently skipping it because the file exists on disk.
            if (fs.existsSync(localFullPath)) {
                try {
                    fs.unlinkSync(localFullPath);
                } catch {
                    // If we can't remove it, log a clear warning so the user knows
                    // the file on disk is invalid and must be removed manually.
                    console.error(`  Warning: could not remove partial file at ${localFullPath} — delete it manually before retrying.`);
                }
            }

            failedCount++;
        }
    }

    console.log(`Download complete. Downloaded: ${downloadedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}.`);
}
