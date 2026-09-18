import { PayrollError } from "../payroll-error.ts";

/**
 * Anything the jurisdiction layer refuses.
 *
 * It EXTENDS `PayrollError` because a pack's refusal is a payroll refusal.
 * The two classes were separate roots, and the generic layer catches whichever
 * one its author happened to import: `payroll-yearend.ts` converts a
 * `PayrollError` from a filing's `population()` into that filing's
 * `populationRefusal` and rethrows anything else, by design, so that one
 * pack's refusal cannot hide another's data. With the roots split, Germany's
 * declared ELSTER refusal was "anything else" — it escaped the conversion and
 * crashed the entire org's year-end enumeration, for every country, and the
 * assistant's payroll_year_end tool reported an undocumented error. A pack
 * author cannot be expected to know which root each caller catches on; the
 * hierarchy has to encode it.
 *
 * Narrower `instanceof PayrollPackError` sites keep their exact meaning. The
 * only widening is that the many `instanceof PayrollError` sites now also
 * honour pack refusals, which is what they were already doing for CA, US and
 * NL — the packs that happened to pick the other root.
 *
 * This still lives in its own module. The cycle hazard both this module and
 * `../payroll-error.ts` were split out to avoid is `extends` evaluating at
 * MODULE-EVALUATION time against a binding a cycle has not initialized yet;
 * the one module imported here imports NOTHING, so this chain is two deep and
 * terminates, and no cycle can run through it. Do not add another import.
 *
 * The rest of the original note stands:
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
export class PayrollPackError extends PayrollError {}

/**
 * A resolved jurisdiction that refuses to compute — unknown country, unknown
 * region, currency mismatch. Lives here beside PayrollPackError (and
 * re-exported from `packs.ts`) so leaf modules like `tax-year-math.ts` can
 * throw it without importing the registry.
 */
export class PayrollJurisdictionError extends PayrollPackError {}
