import Arweave from 'arweave';
import { SyncDB } from './db';
import { readFileSync } from 'fs';
import { arDriveFactory, EID } from 'ardrive-core-js';
import axios from 'axios';

const GQL_ENDPOINT = 'https://arweave-search.goldsky.com/graphql';
const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

export async function runSync(db: SyncDB, askPassword: () => Promise<string | null>) {
    const driveId = db.getConfig('drive_id');
    const walletPath = db.getConfig('wallet_path');
    
    if (!driveId) throw new Error('No drive_id found in config. Did you run checkout?');
    
    console.log(`Starting sync for Drive: ${driveId}...`);

    let arDrive;
    let driveKey: string | undefined;
    
    if (walletPath) {
        const jwk = JSON.parse(readFileSync(walletPath, 'utf8'));
        arDrive = arDriveFactory({ wallet: jwk });
        
        driveKey = db.getConfig('drive_key') || undefined;
        
        if (!driveKey) {
            const pwd = await askPassword();
            if (pwd) {
                console.log('Password received. (Decryption logic will be plugged in)');
                // Here we would use ArDrive Core to derive the drive key and store it
            }
        }
    }

    let hasNextPage = true;
    let cursor = db.getConfig('last_cursor') || null;
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

        console.log(`Fetching next batch from GraphQL... ${cursor ? \`(Cursor: ${cursor})\` : ''}`);
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
            const isPrivate = getTag('Cipher-IV') !== undefined;

            if (!entityId || !entityType) continue;

            try {
                // Fetch the actual JSON metadata
                const txData = await arweave.transactions.getData(txId, { decode: true, string: true }) as string;
                let parsedMeta: any = {};
                
                if (txData) {
                    if (isPrivate) {
                        // TODO: Implement AES decryption here using driveKey
                        // We set name to [Encrypted] for now
                        parsedMeta = { name: '[Encrypted]' };
                    } else {
                        parsedMeta = JSON.parse(txData);
                    }
                }

                // Upsert to DB
                db.upsertEntity({
                    entity_id: entityId,
                    type: entityType,
                    name: parsedMeta.name || 'Unknown',
                    parent_folder_id: parentFolderId,
                    data_tx_id: getTag('Data-Tx-Id') || null,
                    size: parsedMeta.size || null,
                    last_modified: parsedMeta.lastModifiedDate || null,
                    metadata_tx_id: txId
                });

                totalFetched++;
                cursor = edge.cursor;
                db.setConfig('last_cursor', cursor!);
                
            } catch (err: any) {
                console.error(`Failed to process tx ${txId}: ${err.message}`);
            }
        }
        
        console.log(`Synced ${totalFetched} entities so far...`);
    }

    console.log(`Sync complete! ${totalFetched} new/updated entities processed.`);
}