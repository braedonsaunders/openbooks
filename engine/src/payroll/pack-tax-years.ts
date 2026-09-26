/** Pack tax-year resolution. Split from packs.ts (pure moves only). */
import { PAYROLL_COUNTRY_PACKS, payrollPack } from "./pack-registry"
import { payrollDraftTaxYears, payrollSupportedTaxYears } from "./tax-years.ts"
import { taxYearFor } from "./tax-year-math.ts"
import type { PayrollTaxYearEdition, PayrollTaxYearSupport } from "./tax-years.ts"
import { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts"

/**
 * The tax year a pay date falls in, per the PACK's own year definition.
 *
 * `Number(payDate.slice(0, 4))` — what `createPayRun` did — is the calendar
 * year. That is right for the CRA and the IRS and wrong for HMRC (6 April) and
 * the ATO (1 July), and the wrongness is invisible: every YTD accumulator,
 * every cap, and every year-end slip keys on `tax_year`, so a pack with a
 * non-calendar year would silently split one statutory year across two.
 */
export function payrollTaxYear(country: string, payDate: string): number {
  return taxYearFor(payrollPack(country).taxYear, payDate);
}

/**
 * The arithmetic behind `payrollTaxYear` lives in the leaf
 * `tax-year-math.ts` (re-exported above) so the MECHANISM stays testable
 * against jurisdictions no pack has yet — an HMRC 6-April year and an ATO
 * 1-July year — without the generic date module reaching back into this
 * registry (F-reg-003).
 */

/**
 * Refuse a region the pack cannot withhold for, distinguishing "does not
 * exist" from "exists and is not implemented".
 *
 * This is the US pack's existing unsupported-state throw, moved to where the
 * CA pack has to answer the same question about Quebec — which it previously
 * did not answer at all, so a QC employee was quietly withheld the federal
 * half of their income tax and nothing said so.
 */
export function assertPayrollRegionSupported(country: string, region: string): void {
  const { regions } = payrollPack(country);
  if (!regions.known.includes(region)) {
    throw new PayrollJurisdictionError(
      `unknown ${country} ${regions.label} "${region || "(unset)"}" on the payroll profile`,
    );
  }
  if (regions.supported.includes(region)) return;
  throw new PayrollJurisdictionError(
    regions.unsupportedReasons?.[region]
    ?? regions.unsupportedReason.replace("{region}", region),
  );
}

/** True when the pack withholds for the region — the non-throwing form. */
export function payrollRegionSupported(country: string, region: string): boolean {
  const { regions } = payrollPack(country);
  return regions.supported.includes(region);
}

// ---------------------------------------------------------------------------
// Tax-year declarations, read off the pack registry
// ---------------------------------------------------------------------------
//
// These lived in `tax-years.ts` and read this registry from there — the other
// edge that closed the F-reg-003 cycle. They live here now; the pure coverage
// arithmetic (`payrollSupportedTaxYears`, `payrollDraftTaxYears`) stays in
// `tax-years.ts` and takes the declaration as a parameter.

/**
 * Declarations registered beyond the packs (tests, an out-of-tree pack).
 * Everything else is read off the pack registry below.
 */
const EXTRA_PAYROLL_TAX_YEARS = new Map<string, PayrollTaxYearSupport>();

/**
 * Every pack's tax-year declaration, registry packs first. The declarations
 * are authored in each pack's own rate module and carried on
 * `PayrollCountryPack.taxYears` — the same shape `declaredPayrollFilings()`
 * uses. A closed built-ins list here would be a second registry a new pack
 * has to edit after declaring itself.
 */
export function declaredPayrollTaxYears(): PayrollTaxYearSupport[] {
  return [
    ...Object.values(PAYROLL_COUNTRY_PACKS).map((pack) => pack.taxYears),
    ...EXTRA_PAYROLL_TAX_YEARS.values(),
  ];
}

/** Register a pack's tax-year declaration. Refuses a second one per country. */
export function registerPayrollTaxYears(declaration: PayrollTaxYearSupport): void {
  if (!declaration.country) {
    throw new PayrollPackError("a payroll tax-year declaration must name its country");
  }
  if (declaredPayrollTaxYears().some((declared) => declared.country === declaration.country)) {
    throw new PayrollPackError(
      `payroll tax years for ${declaration.country} are already declared — a country has `
      + "exactly one statutory-table declaration",
    );
  }
  EXTRA_PAYROLL_TAX_YEARS.set(declaration.country, declaration);
}

/** Remove a non-built-in registration (test isolation only). */
export function unregisterPayrollTaxYears(country: string): void {
  EXTRA_PAYROLL_TAX_YEARS.delete(country);
}

/** A pack's declaration, or a refusal naming the packs that have one. */
export function payrollTaxYearSupport(country: string): PayrollTaxYearSupport {
  const declared = declaredPayrollTaxYears().find((entry) => entry.country === country);
  if (!declared) {
    throw new PayrollPackError(
      `the ${country || "(unset)"} payroll pack declares no statutory tax years — a pack must `
      + "declare which years its tables are transcribed for. Declared for: "
      + (declaredPayrollTaxYears().map((entry) => entry.country).join(", ") || "none"),
    );
  }
  return declared;
}

/*
 * No `packsMissingTaxYearDeclarations` probe remains: the declaration is a
 * required `PayrollCountryPack` field read off the pack above, so every
 * installable pack answers by construction and there is no list to fall
 * behind. The third-country pack test asserts the derivation.
 */

/**
 * Why a tax year cannot be calculated, or null when it can.
 *
 * `kind` separates the two failures the product must never conflate:
 * `missing` — nobody has transcribed the year; `draft` — a skeleton exists and
 * still carries placeholders, which is the one state where a silent
 * approximation would look like real tables.
 */
export interface PayrollTaxYearProblem {
  country: string;
  region: string | null;
  taxYear: number;
  kind: "missing" | "draft" | "undeclared";
  /**
   * Developer-facing: names the year, the pack, the region, and the
   * developer remedy (scaffold script, rates module). Read by engine throws
   * (`assertPayrollTaxYearSupported`) and logs — never by an operator
   * surface.
   */
  message: string;
  /**
   * Operator-facing: names the pack, the requested year, and the years the
   * pack does publish (or that it publishes none), and states that no action
   * in the product loads a year the pack does not publish. Names no script,
   * file path, or command. Readiness blockers and filing refusals read THIS;
   * `message` keeps the developer text so no caller silently changes
   * audience when this string is edited.
   */
  operatorMessage: string;
}

/**
 * The operator half of a tax-year refusal: what the pack publishes and the
 * fact that no in-product action loads what it does not. The developer half
 * (scaffold command, rates module) stays on `message` for engine throws.
 * Exported for the setup check, which must refuse an undeclared country
 * without a tax year (see below).
 */
export function payrollTaxYearOperatorMessage(
  country: string,
  scope: string,
  taxYear: number | null,
  kind: "missing" | "draft" | "undeclared",
  loaded: number[],
): string {
  const published = loaded.length > 0 ? loaded.join(", ") : "no tax years";
  if (kind === "undeclared") {
    // No pack ⇒ no year arithmetic: the calendar-year guess (`date.slice`)
    // is wrong for every fiscal-year jurisdiction, so when the caller has no
    // year the refusal names the country and stops there.
    const yearClause = taxYear === null ? "" : `, so ${taxYear} cannot be calculated`;
    return (
      `No statutory tables are published for ${country || "(unset)"} — no payroll pack declares `
      + `that country${yearClause}. No action in the product loads tables `
      + `for a country with no pack; the packs tab of payroll setup shows which packs are `
      + `available and the years each publishes.`
    );
  }
  if (kind === "draft") {
    return (
      `${taxYear} statutory tables are not available for ${scope}. `
      + `The ${country} pack publishes ${published}. No action in the product loads a year the `
      + `pack does not publish; the packs tab of payroll setup shows the years each pack publishes.`
    );
  }
  return (
    `${taxYear} statutory tables are not loaded for ${scope} — `
    + `the ${country} pack publishes ${published}. No action in the product loads a year the `
    + `pack does not publish; the packs tab of payroll setup shows the years each pack publishes.`
  );
}

export function payrollTaxYearProblem(
  country: string,
  taxYear: number,
  region?: string | null,
): PayrollTaxYearProblem | null {
  let support: PayrollTaxYearSupport;
  try {
    support = payrollTaxYearSupport(country);
  } catch (error) {
    return {
      country, region: region ?? null, taxYear, kind: "undeclared",
      message: error instanceof Error ? error.message : String(error),
      operatorMessage: payrollTaxYearOperatorMessage(country, country, taxYear, "undeclared", []),
    };
  }
  const scope = region && support.regionsWithOwnTables.includes(region)
    ? `${country} · ${region}`
    : country;
  if (payrollSupportedTaxYears(support, region).includes(taxYear)) return null;
  const loaded = payrollSupportedTaxYears(support, region);
  if (payrollDraftTaxYears(support, region).includes(taxYear)) {
    return {
      country, region: region ?? null, taxYear, kind: "draft",
      message:
        `the ${taxYear} statutory tables for ${scope} are scaffolded but not filled in — the draft `
        + `edition still carries placeholder values. Transcribe the published figures in `
        + `${support.ratesModule} and make its goldens pass before paying into ${taxYear}.`,
      operatorMessage: payrollTaxYearOperatorMessage(country, scope, taxYear, "draft", loaded),
    };
  }
  return {
    country, region: region ?? null, taxYear, kind: "missing",
    message:
      `${taxYear} statutory tables are not loaded for ${scope} — `
      + (loaded.length > 0 ? `loaded years: ${loaded.join(", ")}. ` : "no years are loaded. ")
      + `Scaffold the edition with \`node --import tsx scripts/payroll-new-tax-year.ts --country `
      + `${country} --year ${taxYear}\` and transcribe the published figures into `
      + `${support.ratesModule}.`,
    operatorMessage: payrollTaxYearOperatorMessage(country, scope, taxYear, "missing", loaded),
  };
}

/** The throwing form, for engines that must refuse rather than report. */
export function assertPayrollTaxYearSupported(
  country: string,
  taxYear: number,
  region?: string | null,
): void {
  const problem = payrollTaxYearProblem(country, taxYear, region);
  if (problem) throw new PayrollPackError(problem.message);
}

/** One pack's coverage, for the setup surface. */
export interface PayrollTaxYearCoverage {
  country: string;
  /** True when the pack is a declared country pack (not just a rate table). */
  installable: boolean;
  supported: number[];
  draft: number[];
  ratesModule: string;
  regionsWithOwnTables: string[];
  editions: PayrollTaxYearEdition[];
  /** Regional coverage, only for regions that publish their own tables. */
  regions: { region: string; supported: number[]; draft: number[] }[];
}

export function payrollTaxYearCoverage(): PayrollTaxYearCoverage[] {
  return declaredPayrollTaxYears().map((support) => ({
    country: support.country,
    installable: PAYROLL_COUNTRY_PACKS[support.country]?.installable === true,
    supported: payrollSupportedTaxYears(support),
    draft: payrollDraftTaxYears(support),
    ratesModule: support.ratesModule,
    regionsWithOwnTables: [...support.regionsWithOwnTables],
    editions: [...support.editions].sort((a, b) =>
      a.year - b.year || a.effectiveFrom.localeCompare(b.effectiveFrom)),
    regions: support.regionsWithOwnTables.map((region) => ({
      region,
      supported: payrollSupportedTaxYears(support, region),
      draft: payrollDraftTaxYears(support, region),
    })),
  }));
}

/**
 * The tax year a date falls in for the pack, and whether it is loaded — the
 * one call a surface needs when it holds a date rather than a year. The year
 * itself comes from the pack's own tax-year definition (HMRC's 6 April, the
 * ATO's 1 July), never from `slice(0, 4)`.
 */
export function payrollTaxYearForDate(country: string, date: string): {
  taxYear: number;
  problem: PayrollTaxYearProblem | null;
} {
  // `taxYearFor` is the pack layer's own arithmetic — never a second copy of
  // it, and never `date.slice(0, 4)`.
  const taxYear = taxYearFor(payrollPack(country).taxYear, date);
  return { taxYear, problem: payrollTaxYearProblem(country, taxYear) };
}

/**
 * The tax years a filing surface may offer, derived from the PACKS — never
 * from the calendar year.
 *
 * A picker built from "the current calendar year and the five before it" is
 * right for a calendar-year country and wrong for every fiscal-year one: a
 * September pay date falls in AU tax year 2027 (1 July basis, named for the
 * closing year) while the calendar still reads 2026, so the year the operator
 * just paid was unreachable from the finalisation surface — an STP
 * finalisation that cannot be started. GB (6 April, opening-year naming) can
 * never strand a posted year this way, but the same calendar derivation gave
 * it the wrong DEFAULT in January–March (the calendar's new year while the
 * pack is still in the old one).
 *
 * The range is the six-year window ending at the newest year the packs or
 * the data name — the packs' current tax years, their declared editions, and
 * the years actually present in the org's payroll data — unioned with every
 * declared edition and every data year (a posted run's year is offered even
 * when it falls outside the window). The first element is the default: the
 * pack's current tax year, not the calendar's. The calendar year is never a
 * candidate on its own — appending it would re-hide the basis bug for the
 * next fiscal pack — and serves only as the fallback when no pack is
 * installed and no data exists yet. Unknown country codes are skipped — an
 * undeclared pack contributes nothing rather than refusing the whole surface.
 */
export function payrollFilingYearOptions(input: {
  /** The org's business day (ISO date), never UTC today. */
  today: string;
  /** Installed pack countries. */
  countries: readonly string[];
  /** Tax years actually present in the org's payroll data (posted stubs, carry-ins). */
  dataYears?: readonly number[];
}): number[] {
  const dataYears = (input.dataYears ?? []).filter((year) => Number.isInteger(year));
  const packYears: number[] = [];
  const editionYears: number[] = [];
  for (const country of input.countries) {
    try {
      packYears.push(payrollTaxYearForDate(country, input.today).taxYear);
    } catch {
      continue;
    }
    const support = payrollTaxYearSupport(country);
    editionYears.push(...payrollSupportedTaxYears(support), ...payrollDraftTaxYears(support));
  }
  const named = [...packYears, ...editionYears, ...dataYears];
  let top = Math.max(...named);
  if (!Number.isInteger(top)) {
    // No pack names a year yet (nothing installed, or an undeclared country):
    // the calendar window is the only honest answer. Anything else here —
    // including a malformed business date — refuses rather than offering NaN.
    const calendar = Number(input.today.slice(0, 4));
    if (!Number.isInteger(calendar)) {
      throw new PayrollJurisdictionError(`invalid business date "${input.today}"`);
    }
    top = calendar;
  }
  const years = new Set<number>(dataYears);
  for (const edition of editionYears) years.add(edition);
  for (let year = top; year > top - 6; year--) years.add(year);
  return [...years].sort((a, b) => b - a);
}
