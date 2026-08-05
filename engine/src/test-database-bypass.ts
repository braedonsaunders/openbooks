import { registerRequestOrgResolver } from "./db.ts";

/**
 * Explicit trusted-database boundary for the integration-test process.
 *
 * Most engine integration tests predate request-scoped RLS and intentionally
 * exercise accounting invariants across setup, product calls, and teardown.
 * The test runner preloads this module so those tests retain that cross-org
 * authority without making missing production context authoritative again.
 *
 * This module is deliberately not imported by application code. Refuse to
 * grant the boundary unless the repository test command supplies its explicit
 * opt-in, and refuse it categorically in production.
 */
export function installTrustedTestDatabaseBypass(): void {
  if (
    process.env.OPENBOOKS_TRUSTED_TEST_BYPASS !== "1" ||
    process.env.NODE_ENV === "production"
  ) {
    throw new Error(
      "test database bypass requires OPENBOOKS_TRUSTED_TEST_BYPASS=1 outside production",
    );
  }

  registerRequestOrgResolver(() => ({ orgId: null, bypass: true }));
}

installTrustedTestDatabaseBypass();
