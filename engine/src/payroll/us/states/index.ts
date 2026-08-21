/**
 * The registry of US state withholding engines, and the refusal for every state
 * that has one and every state that does not.
 *
 * The refusal is the point. Before this directory existed, the US pack declared
 * exactly nine supported states — AK, FL, NV, NH, SD, TN, TX, WA, WY — every
 * one of which levies NO income tax on wages. The pack could not withhold state
 * tax anywhere; it supported only the places with nothing to withhold, and
 * refused California, New York, Pennsylvania, Illinois and 38 others outright.
 * A US payroll product that cannot run a Californian payroll cannot run a US
 * payroll.
 *
 * The states delivered here compute end to end. The rest are still refused —
 * and that is the correct behaviour, not a stopgap. What changes is the QUALITY
 * of the refusal: it names the state, names the publication its tables have to
 * be transcribed from, and names the file they go in. A payroll clerk reading
 * "state income tax withholding for CO is not yet supported" learns nothing;
 * one reading "Colorado income tax withholding is not implemented — transcribe
 * DR 1098 into engine/src/payroll/us/states/co.ts and register it here" learns
 * what has to happen.
 *
 * What must NEVER happen, and is structurally impossible here: falling back to
 * the federal calculation, to a neighbouring state's tables, or to a flat
 * "typical" rate. There is no default branch in this module.
 */
import { PayrollError } from "../../../payroll-error.ts";
import { NO_WITHHOLDING_STATES, US_STATES } from "../rates.ts";
import { AL_WITHHOLDING } from "./al.ts";
import { AZ_WITHHOLDING } from "./az.ts";
import { CA_WITHHOLDING } from "./ca.ts";
import { CO_WITHHOLDING } from "./co.ts";
import { CT_WITHHOLDING } from "./ct.ts";
import { DE_WITHHOLDING } from "./de.ts";
import { GA_WITHHOLDING } from "./ga.ts";
import { IA_WITHHOLDING } from "./ia.ts";
import { IL_WITHHOLDING } from "./il.ts";
import { IN_WITHHOLDING } from "./in.ts";
import { KY_WITHHOLDING } from "./ky.ts";
import { MA_WITHHOLDING } from "./ma.ts";
import { MD_WITHHOLDING } from "./md.ts";
import { DETROIT_WITHHOLDING, MI_WITHHOLDING } from "./mi.ts";
import { MN_WITHHOLDING } from "./mn.ts";
import { NC_WITHHOLDING } from "./nc.ts";
import { NJ_WITHHOLDING } from "./nj.ts";
import { NY_WITHHOLDING, NYC_WITHHOLDING, YONKERS_WITHHOLDING } from "./ny.ts";
import { OH_WITHHOLDING } from "./oh.ts";
import { OR_WITHHOLDING } from "./or.ts";
import { PA_WITHHOLDING, PHILADELPHIA_WITHHOLDING } from "./pa.ts";
import { SC_WITHHOLDING } from "./sc.ts";
import { UT_WITHHOLDING } from "./ut.ts";
import { VA_WITHHOLDING } from "./va.ts";
import { WI_WITHHOLDING } from "./wi.ts";
import { WV_WITHHOLDING } from "./wv.ts";
import type { UsStateWithholdingEngine } from "./types.ts";

export class UsStateWithholdingError extends PayrollError {}

/**
 * Region-level engines, one per state, in the order they were delivered.
 *
 * Sub-region engines (New York City, Yonkers, Philadelphia, Detroit) are NOT
 * here: they are reached through their region's declaration, because a
 * sub-region levy only ever applies inside a region whose own withholding has
 * already resolved.
 *
 * A sub-region gets an ENGINE only where its rate is published by an authority
 * this pack can cite. Ohio's municipalities and school districts and Michigan's
 * other twenty-three cities have no engine, by design: their rates are
 * employer-entered, so what they get is a declared levy, a statutory-rate slot
 * and a pure function that refuses without a rate — never a default.
 */
const REGION_ENGINES: readonly UsStateWithholdingEngine[] = [
  CA_WITHHOLDING,
  CO_WITHHOLDING,
  CT_WITHHOLDING,
  NY_WITHHOLDING,
  PA_WITHHOLDING,
  IL_WITHHOLDING,
  // Second wave: New Jersey first because it closes Pennsylvania's reciprocal
  // pair, then the two states that levy below themselves, then three that do
  // not.
  NJ_WITHHOLDING,
  OH_WITHHOLDING,
  MI_WITHHOLDING,
  MA_WITHHOLDING,
  GA_WITHHOLDING,
  NC_WITHHOLDING,
  // Third wave: Arizona's percentage-of-wages election, then the Midwest /
  // Appalachian reciprocity cluster (IN, KY, VA, WV, IA, MN, WI) and Utah.
  AZ_WITHHOLDING,
  IN_WITHHOLDING,
  KY_WITHHOLDING,
  VA_WITHHOLDING,
  WV_WITHHOLDING,
  IA_WITHHOLDING,
  MN_WITHHOLDING,
  WI_WITHHOLDING,
  UT_WITHHOLDING,
  MD_WITHHOLDING,
  OR_WITHHOLDING,
  DE_WITHHOLDING,
  AL_WITHHOLDING,
  SC_WITHHOLDING,
];

const SUB_REGION_ENGINES: readonly UsStateWithholdingEngine[] = [
  NYC_WITHHOLDING,
  YONKERS_WITHHOLDING,
  PHILADELPHIA_WITHHOLDING,
  DETROIT_WITHHOLDING,
];

const BY_STATE = new Map<string, UsStateWithholdingEngine>(
  [...REGION_ENGINES, ...SUB_REGION_ENGINES].map((engine) => [engine.state, engine]),
);

/**
 * Which publication a state's tables must be transcribed from.
 *
 * Every state that levies a wage income tax and is not implemented gets an
 * entry, so the refusal can say WHERE to look rather than "find it yourself".
 * A state absent from this map and absent from `NO_WITHHOLDING_STATES` is a gap
 * in this table, and the meta-test in index.test.ts fails on it — which is how
 * the list stays honest as states are added.
 */
const PUBLICATIONS: Readonly<Record<string, string>> = {
  AR: "Arkansas Withholding Tax Formula (AR4ECX)",
  DC: "District of Columbia FR-230, Income Tax Withholding Instructions and Tables",
  HI: "Hawaii Booklet A, Employer's Tax Guide",
  ID: "Idaho Guide to Income Tax Withholding, Computer Formula",
  KS: "Kansas KW-100, Withholding Tax Guide",
  LA: "Louisiana Employer's Withholding Tax Formula (R-1306)",
  ME: "Maine Withholding Tables for Individual Income Tax",
  MS: "Mississippi Computer Payroll Accounting Withholding Formula",
  MO: "Missouri Employer's Tax Guide, Withholding Formula",
  MT: "Montana Withholding Tax Guide",
  NE: "Nebraska Circular EN, Income Tax Withholding",
  NM: "New Mexico FYI-104, Wage Withholding Tax",
  ND: "North Dakota Income Tax Withholding Rates and Instructions",
  OK: "Oklahoma Income Tax Withholding Tables (Packet OW-2)",
  RI: "Rhode Island Employer's Income Tax Withholding Tables",
  VT: "Vermont Income Tax Withholding Instructions, Tables and Charts",
};

/** The engines the pack carries, for the setup surface and readiness. */
export function usStateWithholdingEngines(): readonly UsStateWithholdingEngine[] {
  return REGION_ENGINES;
}

export function usSubRegionWithholdingEngines(): readonly UsStateWithholdingEngine[] {
  return SUB_REGION_ENGINES;
}

/** Every state whose income tax the pack computes end to end, in US_STATES order. */
export function implementedUsStates(): string[] {
  const implemented = new Set(REGION_ENGINES.map((engine) => engine.state));
  return US_STATES.filter((state) => implemented.has(state));
}

/**
 * Every state the US pack can legitimately pay an employee in: the ones with an
 * engine, plus the ones with no wage income tax to withhold.
 *
 * This is the single source of `PayrollRegionCoverage.supported` for the US
 * pack. Deriving it rather than maintaining a second literal list is the point:
 * the previous list said nine states, and nothing in the codebase could tell
 * that all nine were the no-tax ones.
 */
export function supportedUsStates(): string[] {
  const implemented = new Set(implementedUsStates());
  return US_STATES.filter((state) => implemented.has(state) || NO_WITHHOLDING_STATES.has(state));
}

/** The engine for a state or sub-region, or null. */
export function usStateWithholding(code: string): UsStateWithholdingEngine | null {
  return BY_STATE.get(code) ?? null;
}

/**
 * The engine, or a refusal naming the state, the publication and the file.
 *
 * Three distinct answers, because they are three distinct situations and
 * collapsing them is how a no-tax state gets treated as a bug and an
 * untranscribed state gets treated as a no-tax state:
 *   - an engine exists                     → return it;
 *   - the state levies no wage income tax  → return null, no error;
 *   - the state levies one and we have not transcribed it → THROW.
 */
export function requireUsStateWithholding(code: string): UsStateWithholdingEngine | null {
  const engine = BY_STATE.get(code);
  if (engine) return engine;
  if (NO_WITHHOLDING_STATES.has(code)) return null;
  if (!US_STATES.includes(code as (typeof US_STATES)[number])) {
    throw new UsStateWithholdingError(
      `"${code || "(unset)"}" is not a US state or territory code the payroll pack knows`,
    );
  }
  const publication = PUBLICATIONS[code];
  throw new UsStateWithholdingError(
    `${code} income tax withholding is not implemented by the US payroll pack. `
    + `${code} levies a wage income tax, so nothing here may approximate it: withholding the `
    + "federal amount, a neighbouring state's amount, or nothing at all would each be silently "
    + `wrong money on every stub. Transcribe ${publication ?? `${code}'s published withholding tables`}`
    + ` into engine/src/payroll/us/states/${code.toLowerCase()}.ts and register the engine in `
    + "engine/src/payroll/us/states/index.ts. "
    + `Implemented today: ${implementedUsStates().join(", ")}.`,
  );
}

/** States that levy a wage income tax and have no engine yet, in order. */
export function unimplementedUsStates(): string[] {
  return US_STATES.filter((state) =>
    !NO_WITHHOLDING_STATES.has(state) && !BY_STATE.has(state));
}

/** The publication a named state's tables would be transcribed from, if known. */
export function usStatePublication(code: string): string | null {
  return PUBLICATIONS[code] ?? null;
}

export * from "./types.ts";
export { pctToRate } from "./transcription.ts";
export { AZ_WITHHOLDING, AZ_RATES_2026, AZ_PRINTED_PERCENTS } from "./az.ts";
export { CA_WITHHOLDING, caAnnualizedMethod, CA_RATES_2026 } from "./ca.ts";
export { CO_WITHHOLDING, CO_RATES_2026 } from "./co.ts";
export { CT_WITHHOLDING, CT_RATES_2026 } from "./ct.ts";
export { AL_WITHHOLDING, AL_RATES_2026 } from "./al.ts";
export { DE_WITHHOLDING, DE_RATES_2026 } from "./de.ts";
export { SC_WITHHOLDING, SC_RATES_2026 } from "./sc.ts";
export { IA_WITHHOLDING, IA_RATES_2026 } from "./ia.ts";
export { IN_WITHHOLDING, IN_RATES_2026, IN_COUNTIES_2026 } from "./in.ts";
export { KY_WITHHOLDING, KY_RATES_2026 } from "./ky.ts";
export { MD_WITHHOLDING, MD_RATES_2026, MD_COUNTIES_2026 } from "./md.ts";
export { OR_WITHHOLDING, OR_RATES_2026 } from "./or.ts";
export { MN_WITHHOLDING, MN_RATES_2026 } from "./mn.ts";
export { GA_WITHHOLDING, GA_EDITIONS, gaEditionForPayDate, gaStandardDeduction } from "./ga.ts";
export {
  MA_WITHHOLDING, MA_RATES_2026, maAnnualTax, maExemptionFactor, maSupplementalWithholding,
} from "./ma.ts";
export {
  MI_WITHHOLDING, DETROIT_WITHHOLDING, MI_RATES_2026, MI_TAXING_CITIES, MI_CITY_RATE_SOURCE,
  miCityWithholding, miDetroitExemptionPerPeriod, miDetroitResidentRate,
} from "./mi.ts";
export {
  NC_WITHHOLDING, NC_RATES_2026, ncAnnualizedMethod, ncPercentageMethod, ncRoundToDollar,
  ncScheduleFor, ncSupplementalFlat,
} from "./nc.ts";
export { NJ_WITHHOLDING, NJ_RATES_2026, njRateTableFor } from "./nj.ts";
export {
  OH_WITHHOLDING, OH_EDITIONS, OH_SCHOOL_DISTRICTS_2026, ohEditionFor, ohMunicipalWithholding,
  ohOptionalComputerFormula, ohPercentageMethod, ohSchoolDistrict, ohSchoolDistrictWithholding,
} from "./oh.ts";
export { US_LOCAL_RATE_SLOTS } from "./local-rates.ts";
export { IL_WITHHOLDING, IL_RATES_2026 } from "./il.ts";
export { UT_WITHHOLDING, UT_EDITION_2026, UT_EDITIONS } from "./ut.ts";
export { VA_WITHHOLDING, VA_RATES_2026, vaSupplementalFlat } from "./va.ts";
export { WI_WITHHOLDING, WI_RATES_2026 } from "./wi.ts";
export { WV_WITHHOLDING, WV_RATES_2026 } from "./wv.ts";
export {
  NY_WITHHOLDING, NYC_WITHHOLDING, YONKERS_WITHHOLDING,
  NY_RATES_2026, nysWithholding, yonkersNonresidentAnnualized,
} from "./ny.ts";
export {
  PA_WITHHOLDING, PHILADELPHIA_WITHHOLDING, PA_RATES_2026,
  act32LocalEit, localServicesTaxPerPeriod, paUcEmployeeWithholding, philadelphiaRateFor,
} from "./pa.ts";
