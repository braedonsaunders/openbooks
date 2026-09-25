import type { MigrationSource } from "./source.ts";

/**
 * Shared fixtures for the sync integration suites (DB-owned).
 *
 * A null-object migration source: every collection hook resolves empty and
 * nativeChanges throws, so suites that only exercise one loader path share
 * one stub. Pure stub — no assertions, so no behavioural cover moves.
 */
export function stubMigrationSource(): MigrationSource {
  return {
    name: "migration-test",
    refKey: "migrationTest",
    baseCurrency: "CAD",
    accountingPeriods: async () => [],
    entities: async () => [],
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  };
}
