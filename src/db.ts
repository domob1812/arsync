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

                -- Ordering fields: block_height is the canonical ArFS revision
                -- ordering key; unix_time is the tie-breaker for two revisions
                -- that land in the same block (per the ArFS spec).
                block_height INTEGER NOT NULL DEFAULT 0,
                unix_time INTEGER NOT NULL DEFAULT 0,

                synced_local_sha256 TEXT,
                synced_local_mtime INTEGER,
                synced_local_size INTEGER
            );

            -- Tracks metadata transactions whose payload could not be fetched.
            --
            -- fail_type distinguishes the two fundamentally different failure
            -- classes:
            --
            --   'transient'  — HTTP 5xx / network timeout.  The gateway
            --                  encountered an internal error or was temporarily
            --                  unreachable.  These should be retried
            --                  unconditionally on every subsequent 'update' run
            --                  (up to max_retries, after which they are demoted
            --                  to 'missing').
            --
            --   'missing'    — HTTP 404.  The gateway exhausted all of its
            --                  retrieval sources (trusted peers, chunk assembly,
            --                  direct Arweave nodes) and definitively reported
            --                  the data as unavailable.  These are retried with
            --                  exponential back-off and, optionally, against a
            --                  different gateway via 'arsync retry-failed'.
            --
            -- The cursor and block_height columns are copied verbatim from the
            -- GQL edge so that a successful retry can reconstruct the full
            -- upsert call without re-fetching from GraphQL.
            CREATE TABLE IF NOT EXISTS failed_fetches (
                metadata_tx_id  TEXT PRIMARY KEY,
                entity_id       TEXT,
                entity_type     TEXT,
                block_height    INTEGER,
                unix_time       INTEGER,
                parent_folder_id TEXT,
                gql_cursor      TEXT,
                fail_type       TEXT NOT NULL CHECK(fail_type IN ('transient','missing')),
                http_status     INTEGER,           -- actual HTTP status code, if available
                error_message   TEXT,
                retry_count     INTEGER NOT NULL DEFAULT 0,
                first_failed_at INTEGER NOT NULL,  -- unix epoch seconds
                last_failed_at  INTEGER NOT NULL   -- unix epoch seconds
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
        block_height: number, unix_time: number
    }) {
        const db = await this.dbPromise;
        await db.run(`
            INSERT INTO entities (entity_id, type, name, parent_folder_id, data_tx_id, size, last_modified, metadata_tx_id, block_height, unix_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_id) DO UPDATE SET
                name = excluded.name,
                parent_folder_id = excluded.parent_folder_id,
                data_tx_id = excluded.data_tx_id,
                size = excluded.size,
                last_modified = excluded.last_modified,
                metadata_tx_id = excluded.metadata_tx_id,
                block_height = excluded.block_height,
                unix_time = excluded.unix_time
            WHERE excluded.block_height > entities.block_height
               OR (excluded.block_height = entities.block_height AND excluded.unix_time >= entities.unix_time)
        `, [
            entity.entity_id, entity.type, entity.name, entity.parent_folder_id,
            entity.data_tx_id, entity.size, entity.last_modified, entity.metadata_tx_id,
            entity.block_height, entity.unix_time
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

    /**
     * Count entities whose parent_folder_id does not resolve to any known
     * entity in the database (and is not the drive root itself).
     *
     * These are "orphaned" entities caused by a failed metadata fetch for
     * their parent folder.  They are correctly stored in the database but
     * invisible to tree-walking queries until the parent is recovered.
     */
    public async countOrphanedEntities(driveId: string): Promise<number> {
        const db = await this.dbPromise;
        const row = await db.get(`
            SELECT COUNT(*) as cnt FROM entities
            WHERE parent_folder_id IS NOT NULL
              AND parent_folder_id != ?
              AND parent_folder_id NOT IN (SELECT entity_id FROM entities)
        `, driveId);
        return row ? row.cnt : 0;
    }

    public async updateSyncState(entityId: string, sha256: string, mtime: number, size: number) {
        const db = await this.dbPromise;
        await db.run(
            'UPDATE entities SET synced_local_sha256 = ?, synced_local_mtime = ?, synced_local_size = ? WHERE entity_id = ?',
            sha256, Math.floor(mtime), size, entityId
        );
    }

    // -------------------------------------------------------------------------
    // failed_fetches table
    // -------------------------------------------------------------------------

    /**
     * Record (or update) a failed metadata payload fetch.
     *
     * On the first failure a new row is inserted.  On subsequent failures for
     * the same tx the retry_count is incremented, last_failed_at is updated,
     * and the error details are refreshed — but first_failed_at is preserved.
     *
     * Callers that demote a 'transient' entry to 'missing' (after too many
     * retries) should call this method again with fail_type = 'missing'; the
     * INSERT OR REPLACE will overwrite the row while keeping the original
     * first_failed_at via the MAX() trick in the ON CONFLICT clause.
     */
    public async recordFailedFetch(params: {
        metadata_tx_id:   string;
        entity_id:        string | null;
        entity_type:      string | null;
        block_height:     number | null;
        unix_time:        number | null;
        parent_folder_id: string | null;
        gql_cursor:       string | null;
        fail_type:        'transient' | 'missing';
        http_status:      number | null;
        error_message:    string;
    }): Promise<void> {
        const db = await this.dbPromise;
        const now = Math.floor(Date.now() / 1000);
        await db.run(`
            INSERT INTO failed_fetches (
                metadata_tx_id, entity_id, entity_type, block_height, unix_time,
                parent_folder_id, gql_cursor, fail_type, http_status, error_message,
                retry_count, first_failed_at, last_failed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(metadata_tx_id) DO UPDATE SET
                fail_type      = excluded.fail_type,
                http_status    = excluded.http_status,
                error_message  = excluded.error_message,
                retry_count    = failed_fetches.retry_count + 1,
                last_failed_at = excluded.last_failed_at
        `, [
            params.metadata_tx_id,
            params.entity_id,
            params.entity_type,
            params.block_height,
            params.unix_time,
            params.parent_folder_id,
            params.gql_cursor,
            params.fail_type,
            params.http_status,
            params.error_message,
            now, now
        ]);
    }

    /**
     * Remove a row from failed_fetches once it has been successfully retried.
     */
    public async clearFailedFetch(metadataTxId: string): Promise<void> {
        const db = await this.dbPromise;
        await db.run('DELETE FROM failed_fetches WHERE metadata_tx_id = ?', metadataTxId);
    }

    /**
     * Return all failed fetch rows of a given type, ordered by block height so
     * retries proceed in the same chronological order as the original sync.
     *
     * @param failType  'transient' | 'missing' | 'all'
     */
    public async getFailedFetches(failType: 'transient' | 'missing' | 'all'): Promise<any[]> {
        const db = await this.dbPromise;
        if (failType === 'all') {
            return db.all('SELECT * FROM failed_fetches ORDER BY block_height ASC');
        }
        return db.all(
            'SELECT * FROM failed_fetches WHERE fail_type = ? ORDER BY block_height ASC',
            failType
        );
    }

    /**
     * Return a summary count of failed fetches grouped by type.
     */
    public async countFailedFetches(): Promise<{ transient: number; missing: number }> {
        const db = await this.dbPromise;
        const rows = await db.all(
            'SELECT fail_type, COUNT(*) as cnt FROM failed_fetches GROUP BY fail_type'
        );
        const result = { transient: 0, missing: 0 };
        for (const row of rows) {
            if (row.fail_type === 'transient') result.transient = row.cnt;
            if (row.fail_type === 'missing')   result.missing   = row.cnt;
        }
        return result;
    }
}