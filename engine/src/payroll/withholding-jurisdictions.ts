/**
 * The jurisdictions that withhold income tax, and the levies each one imposes.
 *
 * A payroll pack has always declared its REGIONS (engine/src/payroll/packs.ts:
 * `PayrollRegionCoverage`) — which codes exist and which ones the engine can
 * calculate. That is enough while a region is an indivisible unit that taxes
 * exactly the people who work in it. It stops being enough the moment either
 * half of that sentence is false, and in the United States both halves are:
 *
 *   - New York City and Yonkers levy their own income taxes INSIDE New York
 *     State; Philadelphia levies a wage tax inside Pennsylvania; every
 *     Pennsylvania municipality and school district levies an earned income tax
 *     under Act 32; several hundred Ohio municipalities and school districts do
 *     the same. A "region" is not the smallest taxing unit.
 *   - a state taxes wages EARNED there (nonresidents included) and, separately,
 *     taxes its own RESIDENTS on wages earned elsewhere. Which of the two
 *     applies is a fact about the employee, not about the region.
 *
 * Both are declared here, by the pack, and read by generic code. Nothing in
 * this module names a country, a state, a city or a form.
 *
 * The vocabulary is deliberately the one already in the codebase:
 * `sub_region` is the level `PayrollCertificate.scope` uses and the scope
 * `PayrollRateScope` is extended with in engine/src/payroll/statutory-rates.ts.
 * One word, one idea, no translation layer.
 */
import { PayrollError } from "../payroll-error.ts";

export class PayrollJurisdictionError extends PayrollError {}

// ---------------------------------------------------------------------------
// Who a levy reaches
// ---------------------------------------------------------------------------

/**
 * Whose wages a levy reaches, relative to the taxing jurisdiction.
 *
 * `resident` — people who LIVE in the jurisdiction (New York City's resident
 *   income tax; a Pennsylvania municipality's resident EIT rate).
 * `nonresident` — people who WORK in it but live elsewhere (Yonkers's
 *   nonresident earnings tax; Philadelphia's nonresident wage tax; a
 *   Pennsylvania municipality's nonresident EIT rate).
 *
 * A levy declares BOTH where it reaches both, because the two usually carry
 * different rates and conflating them is a large, quiet error: Philadelphia's
 * nonresident rate is materially lower than its resident rate, and a system
 * that stores one number bills every commuter at the wrong one.
 */
export type PayrollLevyReach = "resident" | "nonresident";

/**
 * Where the rate for a levy comes from.
 *
 * `pack` — a published constant in the pack's own edition modules, versioned by
 *   tax year like every other statutory table (New York City's and Yonkers's
 *   schedules; a state's brackets).
 * `tenant` — a `payroll_statutory_rates` slot the EMPLOYER fills in, because no
 *   publication a payroll system can carry supplies it. Pennsylvania's Act 32
 *   register lists a resident and a nonresident rate for roughly 2,500
 *   municipalities and revises them every year; carrying that as a pack
 *   constant means the product is wrong for whichever municipality was revised
 *   after the release, silently. The employer looks the PSD up and enters it,
 *   the same way they enter their SUI experience rate.
 */
export type PayrollLevyRateSource =
  | { kind: "pack" }
  | { kind: "tenant"; rateKey: string };

/**
 * One taxing unit BELOW a region.
 *
 * Identified by a pack-assigned code that is unique within the region. The code
 * is opaque to generic code — Pennsylvania's are PSD codes from the DCED
 * register, New York's are two names — so nothing outside the pack parses it.
 */
export interface PayrollSubRegionLevy {
  /** Unique within the region. */
  code: string;
  /** What the jurisdiction is called, for stubs and refusals. */
  label: string;
  /** The kind of unit, for grouping in the UI ("city", "school district"). */
  kind: string;
  reaches: readonly PayrollLevyReach[];
  rateSource: PayrollLevyRateSource;
  /** The certificate that sets withholding for this levy, when one exists. */
  certificateKey?: string;
  /**
   * True when the levy settles on its OWN terms and does not enter the region's
   * `subRegionConflictRule` comparison.
   *
   * Philadelphia is the case: it is outside Act 32 entirely (it is levied under
   * the Sterling Act), so a Philadelphia resident pays the Philadelphia
   * resident rate wherever in Pennsylvania they work, and that is NOT a
   * higher-of comparison against the work municipality — it overrides it.
   * Feeding Philadelphia into Act 32's comparison would produce a plausible
   * number remitted to entirely the wrong authority.
   */
  settlesIndependently?: boolean;
  /** The ordinance or statute the levy is imposed under. */
  citation: string;
  /**
   * True when the engine can actually compute the levy end to end. A declared
   * but unimplemented sub-region is refused BY NAME, which is the whole point
   * of declaring it: "Philadelphia levies a wage tax and this engine does not
   * compute it" is a usable sentence; withholding nothing and saying nothing is
   * not.
   */
  implemented: boolean;
}

// ---------------------------------------------------------------------------
// How competing sub-region levies settle
// ---------------------------------------------------------------------------

/**
 * What happens when an employee's RESIDENCE sub-region and WORK sub-region both
 * levy a tax. This is a jurisdictional rule, so the pack states it; generic
 * code applies whichever rule is declared and knows none of them by name.
 *
 * `both` — both are withheld, independently. New York: a New York City
 *   resident who works in Yonkers owes the NYC resident tax and the Yonkers
 *   nonresident earnings tax, and neither offsets the other.
 * `higher_rate` — one is withheld, at the higher of the two rates, remitted to
 *   the residence jurisdiction. Pennsylvania Act 32's rule for an employee
 *   whose residence EIT rate and work-location nonresident EIT rate differ.
 * `work_only` — only the work jurisdiction's levy is withheld.
 * `residence_only` — only the residence jurisdiction's levy is withheld.
 */
export type PayrollSubRegionConflictRule =
  | "both" | "higher_rate" | "work_only" | "residence_only";

// ---------------------------------------------------------------------------
// How a region treats its residents' out-of-region wages
// ---------------------------------------------------------------------------

/**
 * Whether a region requires an employer to withhold from a RESIDENT's wages
 * that were earned in another region — the half of cross-border withholding
 * that has nothing to do with reciprocity.
 *
 * `none` — the region levies no wage income tax at all, so there is nothing to
 *   withhold either way (Texas, Florida).
 * `not_required` — the region taxes the income on the annual return but does
 *   not require the employer to withhold on out-of-region wages.
 * `required` — the employer must withhold the residence region's tax on wages
 *   earned elsewhere.
 * `required_net_of_credit` — the employer must withhold, but reduced by the
 *   credit for tax withheld to the work region. New Jersey's rule, and by far
 *   the most common shape. It is a genuinely different CALCULATION, not a
 *   footnote: it needs the work region's withholding as an input, which is why
 *   the resolution order below computes the work region first.
 */
export type PayrollResidentWithholding =
  | "none" | "not_required" | "required" | "required_net_of_credit"
  /**
   * The pack has NOT established this region's rule.
   *
   * A first-class value, not an omission. The alternative on offer was to
   * default 47 unresearched states to "required" or "not_required" and be
   * quietly wrong for whichever half guessed badly. `unknown` makes the
   * resolver refuse a cross-border employee at that region rather than pick a
   * side, which is the only defensible answer when nobody has read the statute.
   */
  | "unknown";

export interface PayrollRegionWithholding {
  /** The region code, as `PayrollRegionCoverage.known` spells it. */
  region: string;
  /** What the region calls its own income tax, for stub lines and refusals. */
  label: string;
  /**
   * True when the pack's engine computes this region's income tax end to end.
   * The single source of truth for `PayrollRegionCoverage.supported`, so the
   * two can never disagree.
   */
  implemented: boolean;
  /** Why not, when `implemented` is false — named in the refusal. */
  unimplementedReason?: string;
  /** Does the region withhold from NONRESIDENTS on wages earned there? */
  taxesNonresidentWages: boolean;
  residentWithholding: PayrollResidentWithholding;
  /**
   * True when the engine implements `residentWithholding`. Declared separately
   * from the rule itself because "New York requires it" and "we compute it" are
   * different facts, and collapsing them produces the exact silent failure this
   * whole module exists to prevent.
   */
  residentWithholdingImplemented: boolean;
  /** The withholding certificate for the region, when one exists. */
  certificateKey?: string;
  subRegions: readonly PayrollSubRegionLevy[];
  /**
   * An OPEN set of sub-regions the pack cannot enumerate.
   *
   * Pennsylvania's Act 32 register lists a resident and a nonresident earned
   * income tax rate for roughly 2,500 municipalities and school districts, each
   * identified by a six-digit PSD code, revised annually. Ohio's municipal
   * income taxes are the same shape at a similar count. Enumerating them in a
   * pack would be a data set the size of the rest of the pack combined, wrong
   * for whichever jurisdiction was revised after the release, and wrong
   * SILENTLY.
   *
   * So the pack declares the SHAPE — what the code looks like, who the levy
   * reaches, and where its rate comes from — and the employer supplies the
   * specific jurisdiction and rate, exactly as they supply an experience-rated
   * SUI rate. A code that does not match the declared pattern is still refused
   * by name; what is not refused is a code the pack has simply never heard of.
   */
  openSubRegions?: {
    /** What the units are called, for the UI and refusals ("municipality"). */
    kind: string;
    /** Human label; `{code}` is substituted. */
    label: string;
    /** Regex SOURCE the code must match ("^\\d{6}$" for a PSD code). */
    codePattern: string;
    reaches: readonly PayrollLevyReach[];
    rateSource: PayrollLevyRateSource;
    certificateKey?: string;
    citation: string;
    implemented: boolean;
  };
  subRegionConflictRule: PayrollSubRegionConflictRule;
  /** The statute or publication the above is asserted from. */
  citation: string;
}

export interface PayrollPackWithholding {
  country: string;
  regions: readonly PayrollRegionWithholding[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const BUILT_INS = new Map<string, PayrollPackWithholding>();
const EXTRA = new Map<string, PayrollPackWithholding>();
const SOURCES = new Map<string, () => PayrollPackWithholding>();

/**
 * Register a pack's declaration LAZILY. See
 * `registerPayrollCertificateSource` — the same arrangement, for the same
 * module-evaluation reason.
 */
export function registerPayrollWithholdingSource(
  country: string,
  source: () => PayrollPackWithholding,
): void {
  if (!country) {
    throw new PayrollJurisdictionError("a payroll withholding source must name its country");
  }
  SOURCES.set(country, source);
}

function materializeSources(): void {
  if (SOURCES.size === 0) return;
  for (const [country, source] of [...SOURCES]) {
    if (BUILT_INS.has(country) || EXTRA.has(country)) {
      SOURCES.delete(country);
      continue;
    }
    const declaration = source();
    registerPayrollWithholding(declaration, { builtIn: true });
    SOURCES.delete(country);
  }
}

export function registerPayrollWithholding(
  declaration: PayrollPackWithholding,
  options: { builtIn?: boolean } = {},
): void {
  if (!declaration.country) {
    throw new PayrollJurisdictionError("a payroll withholding declaration must name its country");
  }
  const target = options.builtIn ? BUILT_INS : EXTRA;
  const other = options.builtIn ? EXTRA : BUILT_INS;
  if (other.has(declaration.country) || (target.has(declaration.country) && !options.builtIn)) {
    throw new PayrollJurisdictionError(
      `payroll withholding jurisdictions for ${declaration.country} are already declared`,
    );
  }
  const codes = declaration.regions.map((region) => region.region);
  if (new Set(codes).size !== codes.length) {
    throw new PayrollJurisdictionError(
      `the ${declaration.country} withholding declaration repeats a region`,
    );
  }
  for (const region of declaration.regions) {
    const subCodes = region.subRegions.map((sub) => sub.code);
    if (new Set(subCodes).size !== subCodes.length) {
      throw new PayrollJurisdictionError(
        `${declaration.country} · ${region.region} repeats a sub-region code`,
      );
    }
    if (!region.citation) {
      throw new PayrollJurisdictionError(
        `${declaration.country} · ${region.region} must cite the statute its rules come from`,
      );
    }
    if (region.residentWithholding === "none" && region.taxesNonresidentWages) {
      throw new PayrollJurisdictionError(
        `${declaration.country} · ${region.region} levies no resident wage tax but is declared to `
        + "tax nonresident wages — a region that taxes wages taxes its residents' too",
      );
    }
  }
  target.set(declaration.country, declaration);
}

export function unregisterPayrollWithholding(country: string): void {
  EXTRA.delete(country);
}

export function declaredPayrollWithholding(): PayrollPackWithholding[] {
  materializeSources();
  return [...BUILT_INS.values(), ...EXTRA.values()];
}

export function packWithholding(country: string): PayrollPackWithholding {
  const declared = declaredPayrollWithholding().find((entry) => entry.country === country);
  if (!declared) {
    throw new PayrollJurisdictionError(
      `the ${country || "(unset)"} payroll pack declares no withholding jurisdictions — a pack `
      + "must declare which of its regions levy income tax and what sits below them. Declared "
      + "for: " + (declaredPayrollWithholding().map((entry) => entry.country).join(", ") || "none"),
    );
  }
  return declared;
}

/** One region's declaration, or a refusal naming what the pack declares. */
export function regionWithholding(country: string, region: string): PayrollRegionWithholding {
  const pack = packWithholding(country);
  const found = pack.regions.find((entry) => entry.region === region);
  if (!found) {
    throw new PayrollJurisdictionError(
      `the ${country} payroll pack declares no withholding rules for ${region || "(unset)"} — it `
      + `declares ${pack.regions.length} regions`,
    );
  }
  return found;
}

/**
 * One sub-region levy, or null.
 *
 * Resolves against the ENUMERATED levies first and the OPEN registry second, so
 * a pack that both names New York City and admits arbitrary PSD codes gets the
 * named one when the code matches it. Ordering the other way would let a
 * pattern swallow a jurisdiction the pack took the trouble to describe.
 */
export function subRegionLevy(
  country: string,
  region: string,
  code: string,
): PayrollSubRegionLevy | null {
  const declared = regionWithholding(country, region);
  const named = declared.subRegions.find((sub) => sub.code === code);
  if (named) return named;
  const open = declared.openSubRegions;
  if (!open) return null;
  if (!new RegExp(open.codePattern).test(code)) return null;
  return {
    code,
    label: open.label.replace("{code}", code),
    kind: open.kind,
    reaches: open.reaches,
    rateSource: open.rateSource,
    certificateKey: open.certificateKey,
    citation: open.citation,
    implemented: open.implemented,
  };
}

/** Every region whose income tax the pack computes end to end, in declared order. */
export function implementedRegions(country: string): string[] {
  return packWithholding(country).regions
    .filter((region) => region.implemented)
    .map((region) => region.region);
}
