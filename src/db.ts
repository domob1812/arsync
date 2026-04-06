import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class SyncDB {
    private db: Database.Database;

    constructor(projectRoot: string) {
        const dbDir = path.join(projectRoot, '.arsync');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        this.db = new Database(path.join(dbDir, 'sync.db'));
        this.init();
    }

    private init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS entities (
                entity_id TEXT PRIMARY KEY,
                type TEXT NOT NULL,          -- 'drive', 'folder', 'file'
                name TEXT NOT NULL,
                parent_folder_id TEXT,
                data_tx_id TEXT,             -- For files
                size INTEGER,                -- For files
                last_modified INTEGER,       -- ArFS timestamp
                metadata_tx_id TEXT NOT NULL,
                
                -- Local sync state
                synced_local_sha256 TEXT,
                synced_local_mtime INTEGER,
                synced_local_size INTEGER
            );
        `);
    }

    public setConfig(key: string, value: string) {
        const stmt = this.db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
        stmt.run(key, value);
    }

    public getConfig(key: string): string | null {
        const stmt = this.db.prepare('SELECT value FROM config WHERE key = ?');
        const row = stmt.get(key) as { value: string } | undefined;
        return row ? row.value : null;
    }

    public upsertEntity(entity: {
        entity_id: string, type: string, name: string, parent_folder_id: string | null,
        data_tx_id: string | null, size: number | null, last_modified: number | null, metadata_tx_id: string
    }) {
        const stmt = this.db.prepare(`
            INSERT INTO entities (entity_id, type, name, parent_folder_id, data_tx_id, size, last_modified, metadata_tx_id)
            VALUES (@entity_id, @type, @name, @parent_folder_id, @data_tx_id, @size, @last_modified, @metadata_tx_id)
            ON CONFLICT(entity_id) DO UPDATE SET
                name = excluded.name,
                parent_folder_id = excluded.parent_folder_id,
                data_tx_id = excluded.data_tx_id,
                size = excluded.size,
                last_modified = excluded.last_modified,
                metadata_tx_id = excluded.metadata_tx_id
        `);
        stmt.run(entity);
    }
    
    public getEntity(entityId: string) {
        return this.db.prepare('SELECT * FROM entities WHERE entity_id = ?').get(entityId);
    }
}