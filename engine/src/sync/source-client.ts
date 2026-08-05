/**
 * A query client for the tenant's configured source system.
 *
 * Validation harnesses reconcile against whatever system a tenant migrated
 * from; they should not name a vendor to do it. Connector selection belongs
 * here, inside connector scope.
 */
export { nsClient as sourceClient } from "../netsuite-golden.ts";
