import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';

export class SyncDB {
    private dbPromise: Promise<Database>;

    constructor(projectRoot: string) {
        const dbDir = path.join(projectRoot, '.arsync');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        this.dbPromise = this.init(path.join(dbDir, 'sync.db'));
    }

    private async init(dbPath: string) {
        const db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });

        await db.exec(`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS entities (
                entity_id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                parent_folder_id TEXT,
                data_tx_id TEXT,
                size INTEGER,
                last_modified INTEGER,
                metadata_tx_id TEXT NOT NULL,
                
                unix_time INTEGER NOT NULL DEFAULT 0,
                
                synced_local_sha256 TEXT,
                synced_local_mtime INTEGER,
                synced_local_size INTEGER
            );
        `);
        
        return db;
    }

    public async setConfig(key: string, value: string) {
        const db = await this.dbPromise;
        await db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', key, value);
    }

    public async getConfig(key: string): Promise<string | null> {
        const db = await this.dbPromise;
        const row = await db.get('SELECT value FROM config WHERE key = ?', key);
        return row ? row.value : null;
    }

    public async upsertEntity(entity: {
        entity_id: string, type: string, name: string, parent_folder_id: string | null,
        data_tx_id: string | null, size: number | null, last_modified: number | null, metadata_tx_id: string,
        unix_time: number
    }) {
        const db = await this.dbPromise;
        await db.run(`
            INSERT INTO entities (entity_id, type, name, parent_folder_id, data_tx_id, size, last_modified, metadata_tx_id, unix_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET
                name = excluded.name,
                parent_folder_id = excluded.parent_folder_id,
                data_tx_id = excluded.data_tx_id,
                size = excluded.size,
                last_modified = excluded.last_modified,
                metadata_tx_id = excluded.metadata_tx_id,
                unix_time = excluded.unix_time
            WHERE excluded.unix_time >= entities.unix_time
        `, [
            entity.entity_id, entity.type, entity.name, entity.parent_folder_id,
            entity.data_tx_id, entity.size, entity.last_modified, entity.metadata_tx_id, entity.unix_time
        ]);
    }

    public async getRootFolderId(driveId: string): Promise<string | null> {
        const db = await this.dbPromise;
        const row = await db.get(`
            SELECT entity_id FROM entities 
            WHERE type = 'folder' 
            AND (parent_folder_id IS NULL OR parent_folder_id = ?)
        `, driveId);
        
        if (row) return row.entity_id;
        
        const fallback = await db.get(`
            SELECT entity_id FROM entities e
            WHERE type = 'folder' AND NOT EXISTS (
                SELECT 1 FROM entities p WHERE p.entity_id = e.parent_folder_id AND p.type = 'folder'
            )
        `);
        return fallback ? fallback.entity_id : null;
    }

    public async getChildFolderByName(parentId: string, name: string): Promise<string | null> {
        const db = await this.dbPromise;
        const row = await db.get(`
            SELECT entity_id FROM entities 
            WHERE parent_folder_id = ? AND name = ? AND type = 'folder'
        `, parentId, name);
        return row ? row.entity_id : null;
    }

    public async getChildren(parentId: string): Promise<any[]> {
        const db = await this.dbPromise;
        return await db.all(`SELECT * FROM entities WHERE parent_folder_id = ?`, parentId);
    }

    public async getEntity(entityId: string): Promise<any> {
        const db = await this.dbPromise;
        return await db.get('SELECT * FROM entities WHERE entity_id = ?', entityId);
    }

    public async updateSyncState(entityId: string, sha256: string, mtime: number, size: number) {
        const db = await this.dbPromise;
        await db.run(
            'UPDATE entities SET synced_local_sha256 = ?, synced_local_mtime = ?, synced_local_size = ? WHERE entity_id = ?',
            sha256, Math.floor(mtime), size, entityId
        );
    }
}