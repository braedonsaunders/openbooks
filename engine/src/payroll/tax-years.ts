import { PAYROLL_COUNTRY_PACKS, PayrollPackError, payrollPack, taxYearFor } from "./packs.ts";
import { CA_TAX_YEARS } from "./canada/rates.ts";
import { US_TAX_YEARS } from "./us/rates.ts";

/**
 * Which TAX YEARS a payroll pack's statutory tables are actually loaded for.
 *
 * Every statutory engine in this repository refuses a pay date outside the
 * years it has transcribed — `ratesForPayDate` (T4127), `qcRatesForPayDate`
 * (TP-1015), the Pub 15-T tables, the T4 box caps. That failure mode is right:
 * calculating January 2027 with 2026 constants is silent wrong money on every
 * stub, and it is unrecoverable once remitted.
 *
 * What was missing is the OTHER half — the ability to ask the question before
 * the engine is running. Nothing declared which years were loaded, so the only
 * way to learn that 2027 had not been transcribed was an exception thrown from
 * deep inside `calculateStub` at Calculate time, per employee, in the middle of
 * a payroll. A pack now DECLARES its editions, so:
 *
 *   - `payRunReadiness` names the missing year as a blocker before a run
 *     calculates (engine/src/payroll-readiness.ts);
 *   - the setup surface lists what is loaded and what is not, per pack;
 *   - the year-end enumeration refuses an unsupported year by name instead of
 *     letting one pack's exception blank the page;
 *   - `scripts/payroll-new-tax-year.ts` scaffolds the next edition FROM the
 *     declaration, so the annual rollover is a checklist rather than an
 *     archaeology exercise.
 *
 * The declaration is REQUIRED, like `assessedOn` and `cadence` before it: a new
 * pack must state which years it covers rather than inheriting somebody's
 * assumption that the answer is "the current one".
 *
 * Nothing here knows a country. The two built-in declarations are authored in
 * the packs' own rate modules (engine/src/payroll/{us,canada}/rates.ts), beside
 * the constants they describe, exactly as the filing declarations are authored
 * in `{us,canada}/filings.ts`.
 */

/**
 * One edition of a pack's statutory tables.
 *
 * An edition is the unit the agency publishes, not the year: the CRA issues two
 * Option-1 constant sets in some years (the 122nd in January, the 123rd in
 * July), and Revenu Québec version-stamps its own guide separately. A year is
 * loaded when at least one PUBLISHED edition covers it.
 */
export interface PayrollTaxYearEdition {
  /** The tax year the edition's tables apply to. */
  year: number;
  /** The agency's own edition stamp ("122nd edition", "TP-1015.F-V (2026-01)"). */
  label: string;
  /** ISO date the edition takes effect. */
  effectiveFrom: string;
  /** The publication the numbers were transcribed from. */
  citation: string;
  /**
   * `draft` means the module exists with PLACEHOLDER values — scaffolded by
   * `scripts/payroll-new-tax-year.ts` and not yet filled in from the
   * publication. A draft edition is never calculable: it is reported as a
   * distinct, louder refusal than a missing one, because a half-filled table
   * that silently calculated would be the worst outcome available.
   */
  status: "published" | "draft";
  /**
   * The region whose own publication this edition is, when a region inside the
   * country publishes separately (Revenu Québec's TP-1015 for QC). Absent for
   * the country-wide tables.
   */
  region?: string;
}

/** How the generator scaffolds one file of a new edition. */
export interface PayrollEditionScaffoldFile {
  /** Repo-relative path. `{year}` is substituted. */
  path: string;
  /** What the file is, printed by the generator and in the pack README. */
  purpose: string;
  /** File body. `{year}` and `{priorYear}` are substituted. */
  template: string;
}

/**
 * How a pack's next edition is scaffolded — declared by the PACK, so adding a
 * jurisdiction adds its own skeleton and golden stub without the generator
 * learning anything about it.
 */
export interface PayrollEditionScaffold {
  files: readonly PayrollEditionScaffoldFile[];
  /**
   * The generated barrels that wire year modules into the pack's resolvers. The
   * generator rewrites each one from the year modules actually present on disk,
   * so a new edition is wired by WRITING A FILE rather than by hand-editing a
   * list that somebody will forget. A pack whose regions publish separately has
   * more than one (the CA pack: T4127 and Revenu Québec's TP-1015).
   */
  barrels: readonly {
    /** Repo-relative path of the generated barrel. */
    path: string;
    /** Regex source matching the year modules, capturing the year. */
    modulePattern: string;
    /** Exported const inside each year module. `{year}` is substituted. */
    exportName: string;
    /** Barrel body. `{imports}` and `{entries}` are substituted. */
    template: string;
  }[];
  /** What the human must do after generation, in order. */
  steps: readonly string[];
}

export interface PayrollTaxYearSupport {
  country: string;
  /** Every edition the pack carries, published and draft. REQUIRED. */
  editions: readonly PayrollTaxYearEdition[];
  /**
   * Regions that publish their OWN statutory tables. For these, a year is
   * loaded only when a published edition naming the region exists — Quebec's
   * TP-1015 lagging the CRA's T4127 by a month is a real state the product must
   * be able to describe. A region absent from this list is covered by the
   * country-wide editions.
   */
  regionsWithOwnTables: readonly string[];
  /** The module a new edition is transcribed into — named in every refusal. */
  ratesModule: string;
  /** How `scripts/payroll-new-tax-year.ts` scaffolds the next edition. */
  scaffold: PayrollEditionScaffold;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The built-in declarations, authored in each pack's own rate module. Reached
 * as a list keyed by `country`, never as a hand-maintained map — the same shape
 * `declaredPayrollFilings()` uses, and destined for the same home
 * (`PayrollCountryPack.taxYears`; see .local/handoff-rates.md).
 */
const BUILT_INS: readonly PayrollTaxYearSupport[] = [CA_TAX_YEARS, US_TAX_YEARS];

/** Declarations registered beyond the built-ins (an out-of-tree pack). */
const EXTRA = new Map<string, PayrollTaxYearSupport>();

/** Every pack's tax-year declaration, built-ins first. */
export function declaredPayrollTaxYears(): PayrollTaxYearSupport[] {
  return [...BUILT_INS, ...EXTRA.values()];
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
  EXTRA.set(declaration.country, declaration);
}

/** Remove a non-built-in registration (test isolation only). */
export function unregisterPayrollTaxYears(country: string): void {
  EXTRA.delete(country);
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

/**
 * Every installable pack must answer the question. Asserted by the pack test
 * suite rather than by a type, because the registry is deliberately open.
 */
export function packsMissingTaxYearDeclarations(): string[] {
  return Object.values(PAYROLL_COUNTRY_PACKS)
    .filter((pack) => pack.installable)
    .map((pack) => pack.country)
    .filter((country) => !declaredPayrollTaxYears().some((entry) => entry.country === country));
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/** Years with at least one PUBLISHED country-wide edition, ascending. */
export function payrollSupportedTaxYears(country: string, region?: string | null): number[] {
  const support = payrollTaxYearSupport(country);
  const years = new Set<number>();
  for (const edition of support.editions) {
    if (edition.status !== "published") continue;
    if (edition.region != null) continue;
    years.add(edition.year);
  }
  if (region && support.regionsWithOwnTables.includes(region)) {
    const regional = new Set(
      support.editions
        .filter((edition) => edition.status === "published" && edition.region === region)
        .map((edition) => edition.year),
    );
    for (const year of [...years]) if (!regional.has(year)) years.delete(year);
  }
  return [...years].sort((a, b) => a - b);
}

/** Years scaffolded but NOT filled in, for the same scope. */
export function payrollDraftTaxYears(country: string, region?: string | null): number[] {
  const support = payrollTaxYearSupport(country);
  const scoped = support.editions.filter((edition) =>
    region && support.regionsWithOwnTables.includes(region)
      ? edition.region === region
      : edition.region == null);
  const published = new Set(
    scoped.filter((edition) => edition.status === "published").map((edition) => edition.year),
  );
  return [...new Set(
    scoped
      .filter((edition) => edition.status === "draft" && !published.has(edition.year))
      .map((edition) => edition.year),
  )].sort((a, b) => a - b);
}

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
  /** Ready to show: names the year, the pack, the region, and the fix. */
  message: string;
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
    };
  }
  const scope = region && support.regionsWithOwnTables.includes(region)
    ? `${country} · ${region}`
    : country;
  if (payrollSupportedTaxYears(country, region).includes(taxYear)) return null;
  if (payrollDraftTaxYears(country, region).includes(taxYear)) {
    return {
      country, region: region ?? null, taxYear, kind: "draft",
      message:
        `the ${taxYear} statutory tables for ${scope} are scaffolded but not filled in — the draft `
        + `edition still carries placeholder values. Transcribe the published figures in `
        + `${support.ratesModule} and make its goldens pass before paying into ${taxYear}.`,
    };
  }
  const loaded = payrollSupportedTaxYears(country, region);
  return {
    country, region: region ?? null, taxYear, kind: "missing",
    message:
      `${taxYear} statutory tables are not loaded for ${scope} — `
      + (loaded.length > 0 ? `loaded years: ${loaded.join(", ")}. ` : "no years are loaded. ")
      + `Scaffold the edition with \`node --import tsx scripts/payroll-new-tax-year.ts --country `
      + `${country} --year ${taxYear}\` and transcribe the published figures into `
      + `${support.ratesModule}.`,
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
    supported: payrollSupportedTaxYears(support.country),
    draft: payrollDraftTaxYears(support.country),
    ratesModule: support.ratesModule,
    regionsWithOwnTables: [...support.regionsWithOwnTables],
    editions: [...support.editions].sort((a, b) =>
      a.year - b.year || a.effectiveFrom.localeCompare(b.effectiveFrom)),
    regions: support.regionsWithOwnTables.map((region) => ({
      region,
      supported: payrollSupportedTaxYears(support.country, region),
      draft: payrollDraftTaxYears(support.country, region),
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
