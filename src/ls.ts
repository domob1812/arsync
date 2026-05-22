import fs from 'fs';
import path from 'path';
import { SyncDB } from './db';
import { findProjectRoot } from './utils';
import {
    EntityStatus,
    computeFileStatus,
    computeFolderStatus,
    statusIcon,
    displayName,
} from './status';

const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

export async function runLs(targetPath: string) {
    const cwd = process.cwd();
    const resolvedPath = path.resolve(cwd, targetPath);

    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) {
        console.error('Error: Not inside an arsync project.');
        process.exit(1);
    }

    const relativePath = path.relative(projectRoot, resolvedPath);
    if (relativePath.startsWith('..')) {
        console.error('Error: Path is outside the arsync project.');
        process.exit(1);
    }

    const db = new SyncDB(projectRoot);
    const driveId = await db.getConfig('drive_id');
    if (!driveId) {
        console.error('Error: Project not fully checked out (missing drive_id in db).');
        process.exit(1);
    }

    // -----------------------------------------------------------------------
    // Resolve the ArFS folder path
    // -----------------------------------------------------------------------
    let currentFolderId = await db.getRootFolderId(driveId);
    let currentFolderPath = projectRoot;   // filesystem path of current folder

    const parts = relativePath.split(path.sep).filter(p => p.length > 0);
    for (const part of parts) {
        if (!currentFolderId) break;
        const childId = await db.getChildFolderByName(currentFolderId, part);
        if (!childId) {
            console.error(`Error: Folder '${part}' not found in ArDrive.`);
            process.exit(1);
        }
        currentFolderId = childId;
        currentFolderPath = path.join(currentFolderPath, part);
    }

    if (!currentFolderId) {
        console.error('Error: Could not resolve ArFS folder path.');
        process.exit(1);
    }

    // -----------------------------------------------------------------------
    // List children and compute statuses
    // -----------------------------------------------------------------------
    const children = await db.getChildren(currentFolderId);

    interface ListEntry {
        name: string;
        type: string;
        status: EntityStatus;
    }

    const results: ListEntry[] = [];

    for (const child of children) {
        const childPath = path.join(currentFolderPath, child.name);

        if (child.type === 'file') {
            const st = await computeFileStatus(db, child, childPath);
            results.push({ name: child.name, type: 'file', status: st });
        } else {
            const st = await computeFolderStatus(db, child, childPath);
            results.push({ name: child.name, type: 'folder', status: st });
        }
    }

    // -----------------------------------------------------------------------
    // Detect extra local files (not in DB)
    // -----------------------------------------------------------------------
    if (fs.existsSync(currentFolderPath)) {
        const dbNames = new Set(children.map((c: any) => c.name));
        const localEntries = fs.readdirSync(currentFolderPath, { withFileTypes: true });
        for (const entry of localEntries) {
            if (entry.name === '.arsync') continue;
            if (!dbNames.has(entry.name)) {
                const entryType = entry.isDirectory() ? 'folder' : 'file';
                results.push({ name: entry.name, type: entryType, status: 'orange' });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Sort: directories first, then alphabetically
    // -----------------------------------------------------------------------
    results.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
    });

    // -----------------------------------------------------------------------
    // Print
    // -----------------------------------------------------------------------
    for (const item of results) {
        console.log(`${statusIcon(item.status)} ${displayName(item.name, item.type)}`);
    }

    // Warn about orphaned entities
    const orphanCount = await db.countOrphanedEntities(driveId);
    if (orphanCount > 0) {
        console.log(`\n${YELLOW}Warning: ${orphanCount} entity/entities in the database have unresolved parent folders and are not shown above.${RESET}`);
        console.log(`${YELLOW}         Run \`arsync retry-skipped\` to attempt recovery.${RESET}`);
    }
}
