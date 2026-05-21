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
 *                 Points at arweave.net because it has authoritative,
 *                 complete coverage of all ArFS transactions, including
 *                 older L1 transactions and ANS-104 bundled data items.
 *                 Third-party indexers such as Goldsky have historically
 *                 had coverage gaps for older / less popular drives.
 *
 *   dataGateway — used for all raw data payload fetches (GET .../{txId}).
 *                 The root-path endpoint on a full gateway resolves both
 *                 base-layer L1 transactions and ANS-104 bundled data items
 *                 transparently.  It also integrates with the ardrive-core-js
 *                 ArFSMetadataCache so that payloads already fetched once are
 *                 served from disk on subsequent runs with no network round-trip.
 */

import { GatewayAPI } from 'ardrive-core-js';

export const gqlGateway = new GatewayAPI({
    gatewayUrl: new URL('https://arweave.net/'),
});

export const dataGateway = new GatewayAPI({
    gatewayUrl: new URL('https://arweave.net/'),
});
