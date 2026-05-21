/**
 * diagnose.ts
 *
 * Targeted diagnostic tool for investigating missing entities.
 *
 * Given an entity ID (folder or file), it:
 *   1. Checks the local SQLite DB for the entity.
 *   2. Queries the configured GQL gateway for the entity by Folder-Id / File-Id tag.
 *   3. If found on-chain but missing locally, fetches and displays the raw payload
 *      so that JSON parse / decryption failures can be identified.
 *
 * This lets you answer the critical question for a missing entity:
 *   - "Was it never returned by the GQL indexer we use?"    → indexer coverage gap
 *   - "Was it returned but then skipped?"                   → processing bug
 *   - "Is it in the DB under a different entity_id?"        → upsert/tag bug
 */

import { SyncDB } from './db';
import { gqlGateway, dataGateway } from './gateways';

/** Build a raw GQL query that searches for an entity by a specific tag name+value. */
function makeEntityQuery(tagName: string, entityId: string): { query: string } {
    return {
        query: `{
            transactions(
                tags: [{ name: "${tagName}", values: ["${entityId}"] }]
                sort: HEIGHT_ASC
                first: 10
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
        }`
    };
}

async function queryGateway(
    tagName: string,
    entityId: string
): Promise<{ txId: string; tags: { name: string; value: string }[] }[]> {
    console.log(`\n[GQL] Querying by ${tagName}=${entityId}...`);
    try {
        const result = await gqlGateway.gqlRequest(makeEntityQuery(tagName, entityId));
        if (result.edges.length === 0) {
            console.log(`  → Not found.`);
            return [];
        }
        const rows: { txId: string; tags: { name: string; value: string }[] }[] = [];
        for (const edge of result.edges) {
            const txId = edge.node.id;
            const tags = edge.node.tags as { name: string; value: string }[];
            console.log(`  → Found tx: ${txId}`);
            for (const tag of tags) {
                console.log(`       ${tag.name}: ${tag.value}`);
            }
            rows.push({ txId, tags });
        }
        if (result.pageInfo.hasNextPage) {
            console.log(`  (Note: more results exist beyond first 10 — this entity has many revisions)`);
        }
        return rows;
    } catch (err: any) {
        console.error(`  → Query failed: ${err.message}`);
        return [];
    }
}

export async function runDiagnose(entityId: string, db: SyncDB): Promise<void> {
    console.log(`\n${'='.repeat(72)}`);
    console.log(`DIAGNOSE: ${entityId}`);
    console.log('='.repeat(72));

    // 1. Check local DB
    console.log('\n[LOCAL DB] Checking SQLite database...');
    const localEntity = await db.getEntity(entityId);
    if (localEntity) {
        console.log(`  → Found in local DB:`);
        console.log(`       entity_id:        ${localEntity.entity_id}`);
        console.log(`       type:             ${localEntity.type}`);
        console.log(`       name:             ${localEntity.name}`);
        console.log(`       parent_folder_id: ${localEntity.parent_folder_id}`);
        console.log(`       metadata_tx_id:   ${localEntity.metadata_tx_id}`);
        console.log(`       unix_time:        ${localEntity.unix_time}`);
    } else {
        console.log(`  → NOT found in local DB.`);
    }

    // 2. Query the configured GQL gateway by Folder-Id and File-Id
    const byFolderId = await queryGateway('Folder-Id', entityId);
    const byFileId   = await queryGateway('File-Id',   entityId);
    const foundOnChain = [...byFolderId, ...byFileId];

    // 3. If found on-chain but missing locally, fetch the raw payload to
    //    help identify whether the failure was a JSON parse or decrypt error.
    if (foundOnChain.length > 0 && !localEntity) {
        console.log('\n[PAYLOAD] Entity is on-chain but missing from local DB.');
        console.log('  Fetching raw payload of the first matching transaction...');
        const firstTx = foundOnChain[0];
        try {
            const raw = await dataGateway.getTxData(firstTx.txId as any);
            console.log(`  Raw payload (first 512 bytes, hex): ${raw.slice(0, 512).toString('hex')}`);
            const asText = raw.slice(0, 512).toString('utf8');
            const isPrintable = /^[\x20-\x7E\n\r\t]*$/.test(asText);
            if (isPrintable) {
                console.log(`  Raw payload (first 512 bytes, text): ${asText}`);
            } else {
                console.log(`  (Payload appears to be binary/encrypted — not printable as plain text)`);
            }
        } catch (err: any) {
            console.error(`  Failed to fetch payload: ${err.message}`);
        }
    }

    // 4. Summary
    console.log('\n' + '='.repeat(72));
    console.log('SUMMARY');
    console.log('='.repeat(72));
    console.log(`  In local DB:   ${localEntity ? 'YES' : 'NO'}`);
    console.log(`  On-chain:      ${foundOnChain.length > 0 ? `YES (${foundOnChain.length} tx(s))` : 'NO'}`);

    if (!localEntity && foundOnChain.length === 0) {
        console.log('\n  CONCLUSION: Entity not found anywhere. Verify the entity ID is correct.');
    } else if (!localEntity && foundOnChain.length > 0) {
        console.log('\n  CONCLUSION: Entity is on-chain but missing from local DB.');
        console.log('  The transaction was fetched but skipped during processing.');
        console.log('  Run: arsync update --debug   to see exactly why it was skipped.');
    } else if (localEntity) {
        console.log('\n  CONCLUSION: Entity is present in local DB. No action needed.');
    }

    console.log('');
}
