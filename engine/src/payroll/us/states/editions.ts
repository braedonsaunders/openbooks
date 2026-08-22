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
import { AL_TAX_YEAR_EDITIONS } from "./al.ts";
import { AR_TAX_YEAR_EDITIONS } from "./ar.ts";
import { AZ_TAX_YEAR_EDITIONS } from "./az.ts";
import { CA_TAX_YEAR_EDITIONS } from "./ca.ts";
import { CO_TAX_YEAR_EDITIONS } from "./co.ts";
import { CT_TAX_YEAR_EDITIONS } from "./ct.ts";
import { DE_TAX_YEAR_EDITIONS } from "./de.ts";
import { SC_TAX_YEAR_EDITIONS } from "./sc.ts";
import { GA_TAX_YEAR_EDITIONS } from "./ga.ts";
import { HI_TAX_YEAR_EDITIONS } from "./hi.ts";
import { IA_TAX_YEAR_EDITIONS } from "./ia.ts";
import { ID_TAX_YEAR_EDITIONS } from "./id.ts";
import { KS_TAX_YEAR_EDITIONS } from "./ks.ts";
import { LA_TAX_YEAR_EDITIONS } from "./la.ts";
import { MO_TAX_YEAR_EDITIONS } from "./mo.ts";
import { MS_TAX_YEAR_EDITIONS } from "./ms.ts";
import { MT_TAX_YEAR_EDITIONS } from "./mt.ts";
import { ND_TAX_YEAR_EDITIONS } from "./nd.ts";
import { NE_TAX_YEAR_EDITIONS } from "./ne.ts";
import { OK_TAX_YEAR_EDITIONS } from "./ok.ts";
import { IL_TAX_YEAR_EDITIONS } from "./il.ts";
import { IN_TAX_YEAR_EDITIONS } from "./in.ts";
import { KY_TAX_YEAR_EDITIONS } from "./ky.ts";
import { MA_TAX_YEAR_EDITIONS } from "./ma.ts";
import { ME_TAX_YEAR_EDITIONS } from "./me.ts";
import { MD_TAX_YEAR_EDITIONS } from "./md.ts";
import { MI_TAX_YEAR_EDITIONS } from "./mi.ts";
import { MN_TAX_YEAR_EDITIONS } from "./mn.ts";
import { NC_TAX_YEAR_EDITIONS } from "./nc.ts";
import { NJ_TAX_YEAR_EDITIONS } from "./nj.ts";
import { NY_TAX_YEAR_EDITIONS } from "./ny.ts";
import { OH_TAX_YEAR_EDITIONS } from "./oh.ts";
import { OR_TAX_YEAR_EDITIONS } from "./or.ts";
import { PA_TAX_YEAR_EDITIONS } from "./pa.ts";
import { RI_TAX_YEAR_EDITIONS } from "./ri.ts";
import { VT_TAX_YEAR_EDITIONS } from "./vt.ts";
import { UT_TAX_YEAR_EDITIONS } from "./ut.ts";
import { VA_TAX_YEAR_EDITIONS } from "./va.ts";
import { WI_TAX_YEAR_EDITIONS } from "./wi.ts";
import { WV_TAX_YEAR_EDITIONS } from "./wv.ts";

/** Region-scoped editions, one group per state with an engine. */
export const US_STATE_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [
  ...CA_TAX_YEAR_EDITIONS,
  ...CO_TAX_YEAR_EDITIONS,
  ...CT_TAX_YEAR_EDITIONS,
  ...NY_TAX_YEAR_EDITIONS,
  ...PA_TAX_YEAR_EDITIONS,
  ...IL_TAX_YEAR_EDITIONS,
  ...NJ_TAX_YEAR_EDITIONS,
  ...OH_TAX_YEAR_EDITIONS,
  ...MI_TAX_YEAR_EDITIONS,
  ...MA_TAX_YEAR_EDITIONS,
  ...GA_TAX_YEAR_EDITIONS,
  ...NC_TAX_YEAR_EDITIONS,
  ...AZ_TAX_YEAR_EDITIONS,
  ...IN_TAX_YEAR_EDITIONS,
  ...KY_TAX_YEAR_EDITIONS,
  ...VA_TAX_YEAR_EDITIONS,
  ...WV_TAX_YEAR_EDITIONS,
  ...IA_TAX_YEAR_EDITIONS,
  ...MN_TAX_YEAR_EDITIONS,
  ...WI_TAX_YEAR_EDITIONS,
  ...UT_TAX_YEAR_EDITIONS,
  ...MD_TAX_YEAR_EDITIONS,
  ...OR_TAX_YEAR_EDITIONS,
  ...DE_TAX_YEAR_EDITIONS,
  ...AL_TAX_YEAR_EDITIONS,
  ...SC_TAX_YEAR_EDITIONS,
  ...AR_TAX_YEAR_EDITIONS,
  ...ME_TAX_YEAR_EDITIONS,
  ...RI_TAX_YEAR_EDITIONS,
  ...VT_TAX_YEAR_EDITIONS,
  ...HI_TAX_YEAR_EDITIONS,
  ...ID_TAX_YEAR_EDITIONS,
  ...KS_TAX_YEAR_EDITIONS,
  ...LA_TAX_YEAR_EDITIONS,
  ...MO_TAX_YEAR_EDITIONS,
  ...MS_TAX_YEAR_EDITIONS,
  ...MT_TAX_YEAR_EDITIONS,
  ...ND_TAX_YEAR_EDITIONS,
  ...NE_TAX_YEAR_EDITIONS,
  ...OK_TAX_YEAR_EDITIONS,
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
