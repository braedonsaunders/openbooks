// This module imports nothing at runtime — not even `./packs.ts` (F-reg-003;
// see the note atop `statutory-rates.ts` for why). Country-keyed conveniences
// (`declaredPayrollTaxYears`, `payrollTaxYearSupport`, `payrollTaxYearProblem`,
// `payrollTaxYearForDate`, `payrollTaxYearCoverage`, …) live with the registry
// in `packs.ts`; what stays here takes the pack's declaration as a parameter.

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
 *     calculates (engine/src/payroll/readiness.ts);
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
// Coverage — pure functions over a handed-in declaration
// ---------------------------------------------------------------------------
//
// The registry half (`declaredPayrollTaxYears`, the EXTRA registrations,
// `payrollTaxYearSupport`) moved to `packs.ts`: a function whose whole job is
// "ask every pack" belongs with the registry (F-reg-003). What stays here
// takes the pack's declaration as a parameter instead.

/** Years with at least one PUBLISHED country-wide edition, ascending. */
export function payrollSupportedTaxYears(
  support: PayrollTaxYearSupport,
  region?: string | null,
): number[] {
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
export function payrollDraftTaxYears(
  support: PayrollTaxYearSupport,
  region?: string | null,
): number[] {
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
