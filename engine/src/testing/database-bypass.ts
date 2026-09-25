import { registerRequestOrgResolver } from "../platform/db.ts";

/**
 * Explicit trusted-database boundary for the integration-test process.
 *
 * Most engine integration tests intentionally exercise accounting invariants
 * across setup, product calls, and teardown. The runner preloads this module to
 * route those calls through OPENBOOKS_BYPASS_DB_URL (or the explicit test-admin
 * fallback in db.ts), never by granting authority to a GUC on the app role.
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
