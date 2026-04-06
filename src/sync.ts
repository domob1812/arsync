import Arweave from 'arweave';
import { SyncDB } from './db';
import { readFileSync } from 'fs';
import { arDriveFactory, EID, deriveDriveKey, driveDecrypt, JWKWallet } from 'ardrive-core-js';
import axios from 'axios';

const GQL_ENDPOINT = 'https://arweave-search.goldsky.com/graphql';
const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

export async function runSync(db: SyncDB, askPassword: () => Promise<string | null>) {
    const driveId = db.getConfig('drive_id');
    const walletPath = db.getConfig('wallet_path');
    
    if (!driveId) throw new Error('No drive_id found in config. Did you run checkout?');
    
    console.log(`Starting sync for Drive: ${driveId}...`);

    let arDrive;
    let driveKey: any;
    
    if (walletPath) {
        const jwk = JSON.parse(readFileSync(walletPath, 'utf8'));
        const wallet = new JWKWallet(jwk);
        arDrive = arDriveFactory({ wallet });
        
        const cachedKey = db.getConfig('drive_key');
        if (cachedKey) {
            // Need to parse back to proper object or string based on how it's cached
            // The derived driveKey has a buffer/string structure.
            // For now, if we don't have it in memory, we derive it.
        }
        
        if (!driveKey) {
            const pwd = await askPassword();
            if (pwd) {
                console.log('Deriving drive key...');
                const owner = await wallet.getAddress();
                const driveSignatureInfo = await arDrive.getDriveSignatureInfo({ driveId: driveId as any, owner });
                
                driveKey = await deriveDriveKey({
                    dataEncryptionKey: pwd,
                    driveId,
                    walletPrivateKey: JSON.stringify(wallet.getPrivateKey()),
                    driveSignatureType: driveSignatureInfo.driveSignatureType,
                    encryptedSignatureData: driveSignatureInfo.encryptedSignatureData
                });
                console.log('Drive key derived successfully!');
                // Save stringified representation in DB for future
                // db.setConfig('drive_key', JSON.stringify(driveKey));
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
            const cipherIv = getTag('Cipher-IV');

            if (!entityId || !entityType) continue;

            try {
                // Fetch the actual JSON metadata
                const txData = await arweave.transactions.getData(txId, { decode: true, string: !isPrivate });
                let parsedMeta: any = {};
                
                if (txData) {
                    if (isPrivate && driveKey && cipherIv) {
                        try {
                            const decryptedBuffer = await driveDecrypt(cipherIv, driveKey, Buffer.from(txData as Uint8Array));
                            parsedMeta = JSON.parse(decryptedBuffer.toString('utf8'));
                        } catch(e) {
                            parsedMeta = { name: '[Decryption Failed]' };
                        }
                    } else if (isPrivate) {
                        parsedMeta = { name: '[Encrypted - No Key]' };
                    } else {
                        parsedMeta = JSON.parse(txData as string);
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