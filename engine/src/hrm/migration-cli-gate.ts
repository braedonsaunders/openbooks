/**
 * Production apply interlock for the one-time employment migration CLI.
 *
 * FAIL-CLOSED: the default is refusal. An apply proceeds without controls
 * ONLY when the environment is affirmatively known-safe (NODE_ENV
 * explicitly 'development' or 'test') AND the target database carries the
 * ephemeral marker ('openbooks-ci-ephemeral-*', the same comment
 * scripts/testdb.sh writes and engine/src/testing/fixtures.ts enforces, read
 * back with shobj_description(oid, 'pg_database')). Anything else —
 * NODE_ENV unset, 'production', a typo, or a database without the marker —
 * requires explicit reviewed approval: --allow-production AND a
 * --dry-run-hash matching the report evaluated in the same run.
 *
 * An explicitly supplied but mismatched hash always refuses, even on a safe
 * harbor: it is positive evidence of staleness or confusion, never an
 * inert extra flag.
 *
 * Pure decision function: the CLI supplies the environment, the database
 * marker it read, the requested mode, and the operator controls; unit tests
 * cover the decision table and integration tests prove every refusal path
 * writes nothing to the database.
 */

/** Prefix scripts/testdb.sh writes into the database comment of scratch/CI databases. */
export const EPHEMERAL_DATABASE_MARKER_PREFIX = "openbooks-ci-ephemeral-";

export interface ProductionInterlockInput {
  readonly nodeEnv: string | undefined;
  /** shobj_description(oid, 'pg_database') of the target database; null when absent or unreadable. */
  readonly databaseMarker: string | null | undefined;
  readonly apply: boolean;
  /** Operator acknowledgement flag (--allow-production). */
  readonly allowProduction: boolean;
  /** Operator-supplied reviewed report hash (--dry-run-hash), if any. */
  readonly dryRunHash: string | null;
  /** The dry-run report hash evaluated in this same run. */
  readonly computedHash: string;
}

export type ProductionInterlockRefusalCode =
  | "production_apply_not_acknowledged"
  | "dry_run_hash_missing"
  | "dry_run_hash_mismatch"
  | "environment_unknown"
  | "database_not_ephemeral";

export interface ProductionInterlockRefusal {
  readonly proceed: false;
  readonly code: ProductionInterlockRefusalCode;
  readonly reason: string;
}

export type ProductionInterlockDecision =
  | { readonly proceed: true }
  | ProductionInterlockRefusal;

function isKnownSafeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}

function isEphemeralDatabase(marker: string | null | undefined): boolean {
  return (
    typeof marker === "string" &&
    marker.length > EPHEMERAL_DATABASE_MARKER_PREFIX.length &&
    marker.startsWith(EPHEMERAL_DATABASE_MARKER_PREFIX)
  );
}

export function decideProductionApply(
  input: ProductionInterlockInput,
): ProductionInterlockDecision {
  // Dry runs evaluate and report without writing; there is nothing to interlock.
  if (!input.apply) return { proceed: true };
  // An explicitly supplied but mismatched hash is positive evidence the
  // operator is approving a different report than this run evaluated.
  // It refuses everywhere, including the safe harbor below.
  if (input.dryRunHash !== null && input.dryRunHash !== input.computedHash) {
    return {
      proceed: false,
      code: "dry_run_hash_mismatch",
      reason:
        "refusing apply: --dry-run-hash does not match this run's evaluated " +
        `report (expected ${input.computedHash}, received ${input.dryRunHash}); the inputs ` +
        "changed since review — re-review the dry run and re-supply its hash. Nothing was written.",
    };
  }
  // Reviewed approval (flag plus matching hash) overrides every environment.
  if (input.allowProduction && input.dryRunHash !== null) return { proceed: true };
  // Safe harbor: affirmatively known-safe environment AND an ephemeral
  // database. Either fact alone is not enough.
  if (isKnownSafeEnv(input.nodeEnv) && isEphemeralDatabase(input.databaseMarker)) {
    return { proceed: true };
  }
  if (input.allowProduction) {
    return {
      proceed: false,
      code: "dry_run_hash_missing",
      reason:
        "refusing apply without --dry-run-hash=<sha256>; " +
        "review the dry-run report first, then re-run with its hash. " +
        `This run's dry-run report hash is ${input.computedHash}.`,
    };
  }
  if (input.nodeEnv === "production") {
    return {
      proceed: false,
      code: "production_apply_not_acknowledged",
      reason:
        "refusing production apply without --allow-production AND --dry-run-hash=<sha256>; " +
        "review the dry-run report first, then re-run with its hash. " +
        `This run's dry-run report hash is ${input.computedHash}.`,
    };
  }
  if (!isKnownSafeEnv(input.nodeEnv)) {
    return {
      proceed: false,
      code: "environment_unknown",
      reason:
        `refusing apply: the environment is not affirmatively known-safe (NODE_ENV is ` +
        `${JSON.stringify(input.nodeEnv ?? null)}); an unset or misspelled NODE_ENV never ` +
        "implies a safe target. Either pass --allow-production with the reviewed " +
        "--dry-run-hash, or set NODE_ENV=development or NODE_ENV=test AND point at a " +
        "database carrying the ephemeral marker. Nothing was written. " +
        `This run's dry-run report hash is ${input.computedHash}.`,
    };
  }
  return {
    proceed: false,
    code: "database_not_ephemeral",
    reason:
        "refusing apply: the target database does not carry the ephemeral marker " +
        `(${JSON.stringify(input.databaseMarker ?? null)}), so it is treated as protected ` +
        "regardless of NODE_ENV. Either point at an ephemeral-marked database, or pass " +
        "--allow-production with the reviewed --dry-run-hash. Nothing was written. " +
        `This run's dry-run report hash is ${input.computedHash}.`,
  };
}
