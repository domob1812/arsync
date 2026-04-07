import Arweave from 'arweave';
import { SyncDB } from './db';
import { readFileSync } from 'fs';
import { arDriveFactory, deriveDriveKey, driveDecrypt, deriveFileKey, fileDecrypt, JWKWallet } from 'ardrive-core-js';
import axios from 'axios';
import { setupDriveKey } from './utils';

const GQL_ENDPOINT = 'https://arweave-search.goldsky.com/graphql';
const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

export async function runSync(db: SyncDB, askPassword: () => Promise<string | null>) {
    const driveId = await db.getConfig('drive_id');
    const walletPath = await db.getConfig('wallet_path');
    
    if (!driveId) throw new Error('No drive_id found in config. Did you run checkout?');
    
    console.log(`Starting sync for Drive: ${driveId}...`);

    let arDrive;
    let driveKey: any;
    
    if (walletPath) {
        const jwk = JSON.parse(readFileSync(walletPath, 'utf8'));
        const wallet = new JWKWallet(jwk);
        arDrive = arDriveFactory({ wallet });
        
        const cachedKey = await db.getConfig('drive_key');
        if (cachedKey) {
            // Need to parse back to proper object or string based on how it's cached
            // The derived driveKey has a buffer/string structure.
            // For now, if we don't have it in memory, we derive it.
        }
        
        if (!driveKey) {
            driveKey = await setupDriveKey(arDrive, wallet, driveId, askPassword);
            // Save stringified representation in DB for future
            // db.setConfig('drive_key', JSON.stringify(driveKey));
        }
    }

    let hasNextPage = true;
    let cursor = await db.getConfig('last_cursor') || null;
    let totalFetched = 0;

    while (hasNextPage) {
        const query = `
            query($driveId: String!, $cursor: String) {
                transactions(
                    tags: [
                        { name: "Drive-Id", values: [$driveId] }
                    ],
                    sort: HEIGHT_ASC,
                    first: 50,
                    after: $cursor
                ) {
                    pageInfo { hasNextPage }
                    edges {
                        cursor
                        node {
                            id
                            tags { name value }
                        }
                    }
                }
            }
        `;

        console.log(`Fetching next batch from GraphQL... ${cursor ? `(Cursor: ${cursor})` : ''}`);
        const response = await axios.post(GQL_ENDPOINT, {
            query,
            variables: { driveId, cursor }
        });

        const data = response.data.data.transactions;
        hasNextPage = data.pageInfo.hasNextPage;
        
        const edges = data.edges;
        if (edges.length === 0) {
            console.log('No new transactions found.');
            break;
        }

        for (const edge of edges) {
            const txId = edge.node.id;
            const tags = edge.node.tags as {name: string, value: string}[];
            
            const getTag = (name: string) => tags.find(t => t.name === name)?.value;
            
            const entityType = getTag('Entity-Type');
            const entityId = getTag('File-Id') || getTag('Folder-Id') || getTag('Drive-Id');
            const parentFolderId = getTag('Parent-Folder-Id') || null;
            const unixTimeStr = getTag('Unix-Time');
            const unixTime = unixTimeStr ? parseInt(unixTimeStr, 10) : 0;
            const isPrivate = getTag('Cipher-IV') !== undefined;
            const cipherIv = getTag('Cipher-IV');

            if (!entityId || !entityType) continue;

            try {
                // Fetch the actual JSON metadata
                let parsedMeta: any = {};
                
                try {
                    if (isPrivate && driveKey && cipherIv) {
                        // For private data, fetch as raw base64url string to parse correctly into a Buffer
                        const rawData = await arweave.transactions.getData(txId, { decode: true, string: false });
                        
                        try {
                            // Arweave gateway returns Uint8Array, we cast directly to Node Buffer
                            const encryptedBuffer = Buffer.from(rawData as Uint8Array);
                            
                            let decryptedBuffer: Buffer;
                            if (entityType === 'file') {
                                const fileKey = await deriveFileKey(entityId, driveKey);
                                decryptedBuffer = await fileDecrypt(cipherIv, fileKey, encryptedBuffer);
                            } else {
                                decryptedBuffer = await driveDecrypt(cipherIv, driveKey, encryptedBuffer);
                            }
                            
                            const decryptedString = decryptedBuffer.toString('utf8');
                            if (decryptedString === 'Error' || decryptedBuffer.toString('ascii') === 'Error') {
                                throw new Error('ardrive-core-js returned Error string instead of throwing');
                            }
                            
                            parsedMeta = JSON.parse(decryptedString);
                        } catch(e) {
                            console.warn(`Failed to decrypt metadata for ${txId} (likely corrupted). Skipping transaction: ${e}`);
                            continue;
                        }
                    } else if (isPrivate) {
                        parsedMeta = { name: '[Encrypted - No Key]' };
                    } else {
                        // Public data is just stringified JSON
                        const rawData = await arweave.transactions.getData(txId, { decode: true, string: true });
                        parsedMeta = JSON.parse(rawData as string);
                    }
                } catch (dataErr) {
                    console.error(`Failed to fetch data payload for tx ${txId}:`, dataErr);
                    continue;
                }

                // Upsert to DB
                await db.upsertEntity({
                    entity_id: entityId,
                    type: entityType,
                    name: parsedMeta.name || 'Unknown',
                    parent_folder_id: parentFolderId,
                    data_tx_id: parsedMeta.dataTxId || null,
                    size: parsedMeta.size || null,
                    last_modified: parsedMeta.lastModifiedDate || null,
                    metadata_tx_id: txId,
                    unix_time: unixTime
                });

                totalFetched++;
                cursor = edge.cursor;
                await db.setConfig('last_cursor', cursor!);
                
            } catch (err: any) {
                console.error(`Failed to process tx ${txId}: ${err.message}`);
            }
        }
        
        console.log(`Synced ${totalFetched} entities so far...`);
    }

    console.log(`Sync complete! ${totalFetched} new/updated entities processed.`);
}