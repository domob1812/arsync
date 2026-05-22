import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SyncDB } from './db';

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

/**
 * Four-state model for both files and folders:
 *
 *   GREEN   On disk, matches the latest cloud revision exactly.  For a folder
 *           this means the entire subtree is green.
 *   BLUE    Not yet downloaded, OR previously downloaded but the cloud now has
 *           a newer revision.  For a folder this means the subtree contains at
 *           least one blue entity and no orange/red entities.
 *   ORANGE  Locally modified (or new local file not yet on the cloud).  For a
 *           folder this means the subtree contains at least one orange entity
 *           and no red entities.
 *   RED     Both locally modified AND a newer revision exists on the cloud.
 *           For a folder this means at least one file in the subtree is red.
 */
export type EntityStatus = 'green' | 'blue' | 'orange' | 'red';

const STATUS_PRIORITY: Record<EntityStatus, number> = {
    red:    3,
    orange: 2,
    blue:   1,
    green:  0,
};

export function worstStatus(a: EntityStatus, b: EntityStatus): EntityStatus {
    return STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<EntityStatus, string> = {
    green:  '✓',
    blue:   '↓',
    orange: '↑',
    red:    '✗',
};

const STATUS_COLOR: Record<EntityStatus, string> = {
    green:  '\x1b[32m',
    blue:   '\x1b[1;34m',
    orange: '\x1b[33m',
    red:    '\x1b[1;31m',
};

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const BLUE  = '\x1b[1;34m';

export function statusIcon(status: EntityStatus): string {
    return `${STATUS_COLOR[status]}[${STATUS_ICON[status]}]${RESET}`;
}

export function displayName(name: string, type: string): string {
    if (type === 'folder') {
        return `${BLUE}${BOLD}${name}/${RESET}`;
    }
    return name;
}

// ---------------------------------------------------------------------------
// File status
// ---------------------------------------------------------------------------

/**
 * Compute the status of a single file entity.
 */
export async function computeFileStatus(
    db: SyncDB,
    entity: any,
    filePath: string
): Promise<EntityStatus> {
    const localExists = fs.existsSync(filePath);

    // Not on disk at all → needs download
    if (!localExists) {
        return 'blue';
    }

    const stat = fs.statSync(filePath);

    // ---- local modification check -----------------------------------------
    let localModified: boolean;

    const syncedMtime = entity.synced_local_mtime ?? null;
    const syncedSize  = entity.synced_local_size  ?? null;
    const syncedHash  = entity.synced_local_sha256 ?? null;

    if (syncedMtime !== null && syncedSize !== null &&
        stat.mtimeMs === syncedMtime && stat.size === syncedSize) {
        // Fast path: mtime + size match → hash assumed unchanged
        localModified = false;
    } else if (syncedHash !== null) {
        // Slow path: re-hash and compare
        const currentHash = await sha256File(filePath);
        if (currentHash === syncedHash) {
            // Content same, just touched — update mtime/size
            await db.updateLocalMtime(entity.entity_id, stat.mtimeMs, stat.size);
            localModified = false;
        } else {
            localModified = true;
        }
    } else {
        // No sync state at all (entity synced from metadata but never
        // downloaded through arsync).  Treat as unmodified.
        localModified = false;
    }

    // ---- cloud modification check -----------------------------------------
    const currentDataTxId = entity.data_tx_id ?? null;
    const downloadedTxId  = entity.downloaded_data_tx_id ?? null;

    const cloudModified =
        currentDataTxId !== null &&
        (downloadedTxId === null || downloadedTxId !== currentDataTxId);

    // ---- map to status ----------------------------------------------------
    if (!localModified && !cloudModified) return 'green';
    if (!localModified &&  cloudModified) return 'blue';
    if ( localModified && !cloudModified) return 'orange';
    return 'red';
}

// ---------------------------------------------------------------------------
// Folder status (recursive aggregation)
// ---------------------------------------------------------------------------

/**
 * Compute the aggregated status of a folder by recursively examining all
 * descendants and checking for extra local files.
 */
export async function computeFolderStatus(
    db: SyncDB,
    entity: any,
    dirPath: string
): Promise<EntityStatus> {
    let worst: EntityStatus = 'green';

    const children = await db.getChildren(entity.entity_id);

    for (const child of children) {
        const childPath = path.join(dirPath, child.name);

        if (child.type === 'file') {
            const st = await computeFileStatus(db, child, childPath);
            worst = worstStatus(worst, st);
        } else {
            // Folder — recurse
            const st = await computeFolderStatus(db, child, childPath);
            worst = worstStatus(worst, st);
        }

        // Early exit: red is already the worst possible
        if (worst === 'red') break;
    }

    // Check for extra local files/dirs inside this folder
    if (fs.existsSync(dirPath)) {
        const dbNames = new Set(children.map((c: any) => c.name));
        const localEntries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of localEntries) {
            if (entry.name === '.arsync') continue;
            if (!dbNames.has(entry.name)) {
                worst = worstStatus(worst, 'orange');
                break; // orange is already bad enough from extra-files perspective
            }
        }
    } else if (children.length > 0) {
        // Folder exists in DB but not on disk → at least blue
        worst = worstStatus(worst, 'blue');
    }

    return worst;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
