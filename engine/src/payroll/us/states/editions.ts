/**
 * Every state's statutory-table editions, gathered for the pack's tax-year
 * declaration.
 *
 * WHY THIS EXISTS, and why it is a separate module from `index.ts`:
 *
 * Each state engine already declares its `editions` in the shape
 * `PayrollTaxYearEdition` uses, with `region` set. Nothing consumed them. So an
 * unloaded state-year — a 2027 pay date against 2026 California tables — was
 * discoverable only by CALCULATING, which throws from inside the engine, per
 * employee, in the middle of a payroll. That is precisely the failure
 * engine/src/payroll/tax-years.ts was built to prevent for the federal tables,
 * and the fix is plumbing: put the state editions in the pack's declaration and
 * name the state in `regionsWithOwnTables`, and
 * `payrollTaxYearProblem("US", year, state)` answers before a run calculates.
 *
 * It cannot live in `index.ts` because `index.ts` imports
 * engine/src/payroll/us/rates.ts (for `US_STATES`), and `rates.ts` is where the
 * declaration is assembled — importing back would close a cycle at
 * module-evaluation time. This module imports only the state engines, which
 * import no rate module at runtime.
 */
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { CA_TAX_YEAR_EDITIONS } from "./ca.ts";
import { CO_TAX_YEAR_EDITIONS } from "./co.ts";
import { GA_TAX_YEAR_EDITIONS } from "./ga.ts";
import { IL_TAX_YEAR_EDITIONS } from "./il.ts";
import { MA_TAX_YEAR_EDITIONS } from "./ma.ts";
import { MI_TAX_YEAR_EDITIONS } from "./mi.ts";
import { NC_TAX_YEAR_EDITIONS } from "./nc.ts";
import { NJ_TAX_YEAR_EDITIONS } from "./nj.ts";
import { NY_TAX_YEAR_EDITIONS } from "./ny.ts";
import { OH_TAX_YEAR_EDITIONS } from "./oh.ts";
import { PA_TAX_YEAR_EDITIONS } from "./pa.ts";

/** Region-scoped editions, one group per state with an engine. */
export const US_STATE_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [
  ...CA_TAX_YEAR_EDITIONS,
  ...CO_TAX_YEAR_EDITIONS,
  ...NY_TAX_YEAR_EDITIONS,
  ...PA_TAX_YEAR_EDITIONS,
  ...IL_TAX_YEAR_EDITIONS,
  ...NJ_TAX_YEAR_EDITIONS,
  ...OH_TAX_YEAR_EDITIONS,
  ...MI_TAX_YEAR_EDITIONS,
  ...MA_TAX_YEAR_EDITIONS,
  ...GA_TAX_YEAR_EDITIONS,
  ...NC_TAX_YEAR_EDITIONS,
];

/**
 * The states that publish their own withholding tables, DERIVED from the
 * editions above rather than listed a second time.
 *
 * A state is on this list exactly when the pack carries an edition naming it,
 * which means a year is "loaded" for that state only when the state's own
 * tables are loaded for it — the same treatment Revenu Québec's TP-1015 gets in
 * the Canadian pack, where the province's guide lags the federal one by a month
 * every year and the product has to be able to say so.
 */
export const US_STATES_WITH_OWN_TABLES: readonly string[] = [
  ...new Set(US_STATE_TAX_YEAR_EDITIONS.map((edition) => edition.region!)),
];
