import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SyncDB } from './db';
import { findProjectRoot, setupDriveKey } from './utils';
import { JWKWallet, deriveFileKey, fileDecrypt, GatewayAPI, buildQuery } from 'ardrive-core-js';

// Same two-gateway pattern as sync.ts:
//
// - gqlGateway: Goldsky GraphQL indexer.
//               Used to reliably look up transaction tags by ID (including
//               for ANS-104 bundled data items where /tx/{txId} would fail).
//
// - dataGateway: arweave.net full gateway.
//                Used to fetch raw file data payloads via getTxData(),
//                which uses the root-path endpoint supporting both L1 and
//                ANS-104 bundled items, with retries and ArFSMetadataCache.

const gqlGateway = new GatewayAPI({
    gatewayUrl: new URL('https://arweave-search.goldsky.com/'),
});

const dataGateway = new GatewayAPI({
    gatewayUrl: new URL('https://arweave.net/'),
});

/**
 * Fetches the tags for a given transaction ID via GQL.
 * This is the safe way to retrieve tags for any transaction, including
 * ANS-104 bundled data items, since /tx/{txId} can return 404 for those.
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
        // Note: we do NOT construct arDrive here. setupDriveKey constructs
        // its own arDriveFactory instance internally, pointed at Goldsky.
        // The unused `arDrive` variable that was here before has been removed.
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

    console.log(`Found ${itemsToDownload.length} item(s) in ArDrive subtree.`);

    let downloadedCount = 0;
    let skippedCount = 0;

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
            console.warn(`Skipping ${item.relPath} (no data_tx_id found in local DB. Sync might be incomplete or corrupted).`);
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
            // getTxData() uses the root-path endpoint (arweave.net/{txId}) which correctly
            // handles both L1 and ANS-104 bundled data items, with retries and disk cache.
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
                const dataCipherIv = dataTags.find(t => t.name === 'Cipher-IV')?.value;

                if (!dataCipherIv) {
                    throw new Error('Data transaction is missing Cipher-IV tag');
                }

                // Derive the file-specific key and decrypt.
                const fileKey = await deriveFileKey(entity.entity_id, driveKey);
                buffer = Buffer.from(await fileDecrypt(dataCipherIv, fileKey, buffer));
            }

            // Write decrypted (or plain) file to disk.
            fs.writeFileSync(localFullPath, buffer);

            // Compute SHA256 hash and record sync state in the database.
            // This is the baseline for future change detection (see design notes).
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const stats = fs.statSync(localFullPath);

            await db.updateSyncState(entity.entity_id, hash, stats.mtimeMs, stats.size);
            downloadedCount++;
        } catch (err: any) {
            console.error(`Failed to download ${item.relPath}: ${err.message}`);
        }
    }

    console.log(`Download complete. Downloaded: ${downloadedCount}, Skipped (already exist): ${skippedCount}.`);
}
