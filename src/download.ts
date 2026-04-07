import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import Arweave from 'arweave';
import { SyncDB } from './db';
import { findProjectRoot } from './utils';

const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

export async function runDownload(targetPath: string) {
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
    if (!driveId) {
        console.error("Error: Project not fully checked out.");
        process.exit(1);
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

    // Collect all files to download recursively
    const filesToDownload: { entity: any, relPath: string }[] = [];
    
    async function collectFiles(entityId: string, type: string, currentRelPath: string) {
        if (type === 'file') {
            const entity = await db.getEntity(entityId);
            if (entity) filesToDownload.push({ entity, relPath: currentRelPath });
        } else if (type === 'folder') {
            const children = await db.getChildren(entityId);
            for (const child of children) {
                await collectFiles(child.entity_id, child.type, path.join(currentRelPath, child.name));
            }
        }
    }

    await collectFiles(currentId, currentType, relativePath);

    console.log(`Found ${filesToDownload.length} file(s) in ArDrive subtree.`);

    let downloadedCount = 0;
    let skippedCount = 0;

    for (const item of filesToDownload) {
        const localFullPath = path.join(projectRoot, item.relPath);
        const entity = item.entity;

        if (fs.existsSync(localFullPath)) {
            // Check if sizes differ or just skip since it's already there
            // For now, we use simple existence check based on requirement "download all files missing"
            skippedCount++;
            continue;
        }

        if (!entity.data_tx_id) {
            console.warn(`Skipping ${item.relPath} (no data_tx_id found on network - could be empty or encrypted).`);
            skippedCount++;
            continue;
        }

        console.log(`Downloading ${item.relPath} ...`);
        fs.mkdirSync(path.dirname(localFullPath), { recursive: true });

        try {
            // Download data from Arweave
            const data = await arweave.transactions.getData(entity.data_tx_id, { decode: true });
            const buffer = Buffer.from(data as Uint8Array);
            
            // Write to local disk
            fs.writeFileSync(localFullPath, buffer);
            
            // Compute hash for state index
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');
            const stats = fs.statSync(localFullPath);
            
            // Update database index state
            await db.updateSyncState(entity.entity_id, hash, stats.mtimeMs, stats.size);
            downloadedCount++;
        } catch (err: any) {
            console.error(`Failed to download ${item.relPath}: ${err.message}`);
        }
    }

    console.log(`Download complete. Downloaded: ${downloadedCount}, Skipped (already exist): ${skippedCount}.`);
}