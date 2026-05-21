/**
 * gateways.ts
 *
 * Canonical GatewayAPI instances shared across all arsync modules.
 *
 * Having a single definition here means that a future --gateway CLI flag
 * only needs to be wired up once.  All commands (sync, diagnose, download,
 * etc.) automatically pick up the change.
 *
 * Two distinct instances are used intentionally:
 *
 *   gqlGateway  — used for all GraphQL queries (POST .../graphql).
 *                 Points at Goldsky, which runs a purpose-built search
 *                 backend optimised for tag-filtered queries.
 *                 If you encounter missing entities for a very old drive,
 *                 try switching this to https://arweave.net/ as a fallback.
 *
 *   dataGateway — used for all raw data payload fetches (GET .../{txId}).
 *                 Points at arweave.net because it is a full gateway that
 *                 resolves both base-layer L1 transactions and ANS-104
 *                 bundled data items transparently.  It also integrates
 *                 with the ardrive-core-js ArFSMetadataCache so that
 *                 payloads already fetched once are served from disk on
 *                 subsequent runs with no network round-trip.
 */

import { GatewayAPI } from 'ardrive-core-js';

export const gqlGateway = new GatewayAPI({
    gatewayUrl: new URL('https://arweave-search.goldsky.com/'),
});

export const dataGateway = new GatewayAPI({
    gatewayUrl: new URL('https://arweave.net/'),
});
