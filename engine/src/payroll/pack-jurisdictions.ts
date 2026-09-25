/** Declared employment jurisdictions. Split from packs.ts (ARCH-FILE-SPLIT; pure moves only). */
import { type PayrollJurisdiction } from "./pack-types"
import { PAYROLL_COUNTRY_PACKS, payrollPack } from "./pack-registry"
import { PayrollPackError } from "./payroll-error.ts"

/** Every jurisdiction any installed pack declares, in pack order. */
export function declaredJurisdictions(): readonly PayrollJurisdiction[] {
  return Object.values(PAYROLL_COUNTRY_PACKS).flatMap((pack) => pack.jurisdictions);
}

/**
 * The pack's declaration for a jurisdiction key ('CA-ON', 'US', 'CA-CRA').
 *
 * An undeclared jurisdiction THROWS, naming what is missing. That is the whole
 * point: a province whose holiday calendar nobody has transcribed must stop
 * the calculation, not fall back to a neighbouring province's holidays or to
 * an empty list — an empty list is indistinguishable from "works every day"
 * and would quietly pay nothing on Canada Day.
 */
export function payrollJurisdiction(key: string): PayrollJurisdiction {
  const jurisdiction = declaredJurisdictions().find((j) => j.key === key);
  if (!jurisdiction) {
    throw new PayrollPackError(
      `no payroll pack declares the statutory holiday calendar for "${key}" — `
      + `declare it in engine/src/payroll/packs.ts (declared: `
      + `${declaredJurisdictions().map((j) => j.key).join(", ")})`,
    );
  }
  return jurisdiction;
}

/**
 * The jurisdiction key for an employee's country and province/state. Canadian
 * provinces key as 'CA-XX'; a federally regulated employer keys as 'CA'.
 *
 * `labourJurisdiction` is the employment attribute that overrides the region
 * derivation (`employee_payroll_profiles.labour_jurisdiction`): the labour
 * jurisdiction whose employment standards govern the employment, when it is
 * not the one the work region implies. The region still decides WITHHOLDING —
 * an employee working in Ontario pays Ontario tax whoever regulates the
 * employer — so only this key moves.
 *
 * Generic on purpose: the column names no country, and this function names no
 * country. Which keys exist, and which of them are employment jurisdictions at
 * all, is the pack's declaration (`employmentJurisdictionsOf`); an undeclared
 * value is refused by name at the API boundary
 * (`labourJurisdictionProblem`) rather than silently answered here.
 */
export function jurisdictionKey(
  country: string,
  province: string | null,
  labourJurisdiction?: string | null,
): string {
  const declared = (labourJurisdiction ?? "").trim().toUpperCase();
  if (declared) return declared;
  const region = (province ?? "").trim().toUpperCase();
  if (!region) return country;
  return `${country}-${region}`;
}

/**
 * Why a `labour_jurisdiction` value cannot govern an employment, or null if it
 * can — the API-boundary validator, shaped like `filingAccountProblem`.
 *
 * Two refusals, both by name:
 *
 * - a key no pack declares (a typo, or a province nobody has transcribed) —
 *   accepting it would silently pick the region's answers back up, or refuse
 *   deep inside a pay run instead of at the keyboard;
 * - a key declared with `scope: 'tax_administration'` ('CA-CRA') — an
 *   authority's own office calendar governs remittance due dates, never an
 *   employee's entitlements, and confusing the two is exactly the mistake the
 *   scope field exists to prevent;
 * - a key declared by ANOTHER country's pack — an employment cannot be
 *   governed by a jurisdiction its employer of record does not sit in.
 */
export function labourJurisdictionProblem(
  country: string,
  labourJurisdiction: string | null,
): string | null {
  const value = (labourJurisdiction ?? "").trim();
  if (!value) return null;
  const key = value.toUpperCase();
  const employment = employmentJurisdictionsOf(country);
  if (employment.some((jurisdiction) => jurisdiction.key === key)) return null;
  const offered = `the ${country} payroll pack declares: `
    + employment.map((jurisdiction) => jurisdiction.key).join(", ");
  const declared = declaredJurisdictions().find((jurisdiction) => jurisdiction.key === key);
  if (!declared) {
    return `no payroll pack declares the labour jurisdiction "${value}" — ${offered}`;
  }
  if (declared.scope !== "employment") {
    return `"${value}" is the ${declared.name} calendar — a ${declared.scope} calendar, which `
      + `moves remittance due dates and governs no employee's employment standards. ${offered}`;
  }
  return `"${value}" is a labour jurisdiction of another country's payroll pack, not of `
    + `${country} — ${offered}`;
}

/** Whether ANY pack declares the jurisdiction — the non-throwing probe the
 *  statutory-holiday gate uses to distinguish "transcribed" from "refused". */
export function payrollJurisdictionDeclared(key: string): boolean {
  return declaredJurisdictions().some((jurisdiction) => jurisdiction.key === key);
}

/**
 * A country's EMPLOYMENT jurisdictions — the calendars that bind employers,
 * excluding tax administrations' own office calendars. This is the probe set
 * for an UNDECLARED sibling jurisdiction: if any declared employment calendar
 * in the same country observes a day, an undeclared province almost certainly
 * does too, and the run must stop rather than quietly pay nothing for it.
 */
export function employmentJurisdictionsOf(country: string): readonly PayrollJurisdiction[] {
  return payrollPack(country).jurisdictions.filter((j) => j.scope === "employment");
}
