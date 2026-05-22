import fs from 'fs';
import path from 'path';
import { SyncDB } from './db';
import { findProjectRoot } from './utils';

const COLORS = {
    reset: '\x1b[0m',
    blue: '\x1b[1;34m',
    green: '\x1b[32m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    bold: '\x1b[1m'
};

export async function runLs(targetPath: string) {
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
        console.error("Error: Project not fully checked out (missing drive_id in db).");
        process.exit(1);
    }
    
    let currentFolderId = await db.getRootFolderId(driveId);
    
    const parts = relativePath.split(path.sep).filter(p => p.length > 0);
    for (const part of parts) {
        if (!currentFolderId) break;
        currentFolderId = await db.getChildFolderByName(currentFolderId, part);
    }
    
    const dbItems = new Map<string, any>();
    if (currentFolderId) {
        const rows = await db.getChildren(currentFolderId);
        for (const row of rows) {
            dbItems.set(row.name, row);
        }
    }
    
    const localItems = new Map<string, { type: string }>();
    if (fs.existsSync(resolvedPath)) {
        const stats = fs.statSync(resolvedPath);
        if (stats.isDirectory()) {
            const files = fs.readdirSync(resolvedPath, { withFileTypes: true });
            for (const file of files) {
                if (file.name === '.arsync') continue;
                localItems.set(file.name, {
                    type: file.isDirectory() ? 'folder' : 'file'
                });
            }
        }
    }
    
    const combined = new Map<string, { name: string, type: string, state: string }>();
    
    // Add remote items (and check if they are also local)
    for (const [name, dbItem] of dbItems.entries()) {
        combined.set(name, {
            name,
            type: dbItem.type,
            state: localItems.has(name) ? 'both' : 'remote'
        });
    }
    
    // Add items that are strictly local
    for (const [name, localItem] of localItems.entries()) {
        if (!combined.has(name)) {
            combined.set(name, {
                name,
                type: localItem.type,
                state: 'local'
            });
        }
    }
    
    const items = Array.from(combined.values());
    
    // Sort: directories first, then alphabetically
    items.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
    });
    
    for (const item of items) {
        let stateIcon = '';
        if (item.state === 'both') {
            stateIcon = `${COLORS.green}[✓]${COLORS.reset}`;
        } else if (item.state === 'remote') {
            stateIcon = `${COLORS.cyan}[↓]${COLORS.reset}`;
        } else if (item.state === 'local') {
            stateIcon = `${COLORS.yellow}[↑]${COLORS.reset}`;
        }
        
        let displayName = item.name;
        if (item.type === 'folder') {
            displayName = `${COLORS.blue}${COLORS.bold}${item.name}/${COLORS.reset}`;
        }
        
        console.log(`${stateIcon} ${displayName}`);
    }

    // Warn about orphaned entities that are in the database but invisible
    // to tree-walking because their parent folder's metadata fetch failed.
    const orphanCount = await db.countOrphanedEntities(driveId);
    if (orphanCount > 0) {
        console.log(`\n${COLORS.yellow}Warning: ${orphanCount} entity/entities in the database have unresolved parent folders and are not shown above.${COLORS.reset}`);
        console.log(`${COLORS.yellow}         Run \`arsync retry-skipped\` to attempt recovery.${COLORS.reset}`);
    }
}
