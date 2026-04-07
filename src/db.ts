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
        data_tx_id: string | null, size: number | null, last_modified: number | null, metadata_tx_id: string
    }) {
        const db = await this.dbPromise;
        await db.run(`
            INSERT INTO entities (entity_id, type, name, parent_folder_id, data_tx_id, size, last_modified, metadata_tx_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET
                name = excluded.name,
                parent_folder_id = excluded.parent_folder_id,
                data_tx_id = excluded.data_tx_id,
                size = excluded.size,
                last_modified = excluded.last_modified,
                metadata_tx_id = excluded.metadata_tx_id
        `, [
            entity.entity_id, entity.type, entity.name, entity.parent_folder_id,
            entity.data_tx_id, entity.size, entity.last_modified, entity.metadata_tx_id
        ]);
    }
}