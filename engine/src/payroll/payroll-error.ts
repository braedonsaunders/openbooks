/**
 * Anything the jurisdiction layer refuses.
 *
 * This lives in its own LEAF module -- importing nothing -- on purpose.
 * `packs.ts` imports every country pack to build PAYROLL_COUNTRY_PACKS, and
 * the packs need this class at runtime. While only CA and US were registered
 * the loop never closed; registering a third pack closes it, and the cycle
 * becomes load-order dependent: a pack can be evaluated before the binding it
 * needs exists, giving `Cannot access 'X' before initialization` in whichever
 * pack the import order happens to reach first.
 *
 * Five of the eight written packs import it at runtime (GB, IE, AU, FR, ES),
 * so fixing only the packs that happen to fail today would leave the same trap
 * armed for the next import-order change. A leaf has no cycle to be part of.
 *
 * `packs.ts` re-exports it, so existing `import { PayrollPackError } from
 * "../packs.ts"` call sites keep working.
 */
export class PayrollPackError extends Error {}

/**
 * A resolved jurisdiction that refuses to compute — unknown country, unknown
 * region, currency mismatch. Lives here beside PayrollPackError (and
 * re-exported from `packs.ts`) so leaf modules like `tax-year-math.ts` can
 * throw it without importing the registry.
 */
export class PayrollJurisdictionError extends PayrollPackError {}
