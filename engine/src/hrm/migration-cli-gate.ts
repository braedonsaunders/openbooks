/**
 * Production apply interlock for the one-time employment migration CLI.
 *
 * Pure decision function: given the runtime environment, the requested mode,
 * and the operator-supplied controls, it returns either proceed or a coded
 * refusal naming the missing or mismatched control. The CLI calls it after
 * evaluating the dry-run report and before writing anything; unit tests
 * cover the decision table and integration tests prove every refusal path
 * writes nothing to the database.
 */

export interface ProductionInterlockInput {
  readonly nodeEnv: string | undefined;
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
  | "dry_run_hash_mismatch";

export interface ProductionInterlockRefusal {
  readonly proceed: false;
  readonly code: ProductionInterlockRefusalCode;
  readonly reason: string;
}

export type ProductionInterlockDecision =
  | { readonly proceed: true }
  | ProductionInterlockRefusal;

export function decideProductionApply(
  input: ProductionInterlockInput,
): ProductionInterlockDecision {
  if (!input.apply) return { proceed: true };
  if (input.nodeEnv !== "production") return { proceed: true };
  if (!input.allowProduction) {
    return {
      proceed: false,
      code: "production_apply_not_acknowledged",
      reason:
        "refusing production apply without --allow-production AND --dry-run-hash=<sha256>; " +
        "review the dry-run report first, then re-run with its hash. " +
        `This run's dry-run report hash is ${input.computedHash}.`,
    };
  }
  if (input.dryRunHash === null) {
    return {
      proceed: false,
      code: "dry_run_hash_missing",
      reason:
        "refusing production apply without --dry-run-hash=<sha256>; " +
        "review the dry-run report first, then re-run with its hash. " +
        `This run's dry-run report hash is ${input.computedHash}.`,
    };
  }
  if (input.dryRunHash !== input.computedHash) {
    return {
      proceed: false,
      code: "dry_run_hash_mismatch",
      reason:
        "refusing production apply: --dry-run-hash does not match this run's evaluated " +
        `report (expected ${input.computedHash}, received ${input.dryRunHash}); the inputs ` +
        "changed since review — re-review the dry run and re-supply its hash. Nothing was written.",
    };
  }
  return { proceed: true };
}
