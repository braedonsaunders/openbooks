/** The country-pack registry and its derived lookups. Split from packs.ts (ARCH-FILE-SPLIT; pure moves only). */
import { type PayrollStatutoryReportingCode, type PayrollStatutoryComponent, type PayrollCountry, type PayrollCountryPack } from "./pack-types"
import { CA_PAYROLL_PACK } from "./canada/pack.ts"
import { US_PAYROLL_PACK } from "./us/pack.ts"
import { GB_PACK } from "./gb/pack.ts"
import { DE_PAYROLL_PACK } from "./de/pack.ts"
import { FR_PAYROLL_PACK } from "./fr/pack.ts"
import { IE_PAYROLL_PACK } from "./ie/pack.ts"
import { AU_PAYROLL_PACK } from "./au/pack.ts"
import { IT_PAYROLL_PACK } from "./it/pack.ts"
import { NL_PAYROLL_PACK } from "./nl/pack.ts"
import { ES_PAYROLL_PACK } from "./es/pack.ts"
import { SG_PAYROLL_PACK } from "./sg/pack.ts"
import { JP_PAYROLL_PACK } from "./jp/pack.ts"
import { PL_PAYROLL_PACK } from "./pl/pack.ts"
import { BR_PAYROLL_PACK } from "./br/pack.ts"
import { registerPayrollCertificateSource } from "./certificates.ts"
import { registerPayrollReciprocitySource } from "./reciprocity.ts"
import { registerPayrollWithholdingSource } from "./withholding-jurisdictions.ts"
import { registerEmployerFacts } from "./employer-facts.ts"
import { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts"


// --- Canadian jurisdictions ------------------------------------------------
// Declared in ./canada/employment-standards.ts, beside the T4127 constants and
// the CA filing declarations — the country pack's Canadian facts live in the
// country pack's Canadian tree. Moved verbatim; the six previously declared
// jurisdictions are byte-for-byte the same declarations they were.


// --- United States ---------------------------------------------------------


export const PAYROLL_COUNTRY_PACKS: Record<string, PayrollCountryPack> = {
  CA: CA_PAYROLL_PACK,
  US: US_PAYROLL_PACK,
  GB: GB_PACK,
  DE: DE_PAYROLL_PACK,
  FR: FR_PAYROLL_PACK,
  IE: IE_PAYROLL_PACK,
  AU: AU_PAYROLL_PACK,
  // F-reg-003 is fixed: the generic rate and tax-year modules take the pack's
  // declarations as parameters instead of importing this registry, so Italy —
  // the first pack to need actual behaviour (`resolveStatutoryRates`) rather
  // than types — registers like every other pack.
  IT: IT_PAYROLL_PACK,
  NL: NL_PAYROLL_PACK,
  ES: ES_PAYROLL_PACK,
  SG: SG_PAYROLL_PACK,
  JP: JP_PAYROLL_PACK,
  PL: PL_PAYROLL_PACK,
  BR: BR_PAYROLL_PACK,
};

// This is a country-key dictionary: inherited Object names must not pass a
// registry lookup or an API's `country in PAYROLL_COUNTRY_PACKS` validation.
Object.setPrototypeOf(PAYROLL_COUNTRY_PACKS, null);

/**
 * The packs' certificate, withholding and reciprocity declarations, published
 * to the registries that read them.
 *
 * LAZY on purpose. The registries hold the pack's own thunk and build the
 * declaration on the first READ, so nothing here dereferences
 * `us/jurisdictions.ts` while this module is still evaluating. Before this,
 * `us/jurisdictions.ts` registered itself at the bottom of its own file — and
 * NOTHING IMPORTED IT, so the registrations never ran and every declaration in
 * it was dead code that 119 passing tests could not see, because those tests
 * imported the module for its side effect themselves.
 *
 * Generic: it iterates the pack registry and branches on nothing. A pack that
 * declares no reciprocity registers no source, which is how "Canada has no
 * interprovincial agreements" is said.
 */
export function publishPackDeclarations(): void {
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    registerEmployerFacts(pack.country, pack.employerFacts);
    registerPayrollCertificateSource(pack.country, pack.certificates);
    registerPayrollWithholdingSource(pack.country, pack.withholding);
    if (pack.reciprocity) registerPayrollReciprocitySource(pack.country, pack.reciprocity);
  }
}

publishPackDeclarations();

/** Every statutory component a pack provisions, in slot order. */
export function packStatutoryComponents(country: string): readonly PayrollStatutoryComponent[] {
  return payrollPack(country).statutorySlots.flatMap((slot) => slot.components);
}

/**
 * System keys of every statutory component that is an INCOME-TAX withholding,
 * derived from the pack declarations — never a hand-maintained key list.
 *
 * The predicate is `kind === "deduction"` and `assessedOn === "taxable_income"`,
 * and each half is load-bearing:
 *
 * - `deduction` (not `employer_contribution`, not `credit`) keeps the figure
 *   to amounts withheld from the employee's pay. The Italian refundable
 *   credits (`ti_payout`, `somma_payout`) ride `remittance: "tax_authority"`
 *   but they INCREASE net — counting them as tax withheld would understate it.
 * - `taxable_income` (not `earnings`) keeps employee social contributions OUT.
 *   CPP/EI/QPIP, PRSI, USC, NIC, ZUS, INPS, the French cotisations — every one
 *   is a deduction remitted to an authority, but none is income tax, and a
 *   payslip's "YTD tax" conventionally means income tax withheld. Counting
 *   them would overstate the figure, the mirror image of the defect below.
 * - `remittance` is DELIBERATELY not part of the predicate. Québec income tax
 *   and US state/local income tax remit to a per-component destination
 *   (`external`: Revenu Québec, the state agency) rather than the pack's
 *   statutory vendor — filtering on `tax_authority` would silently drop them
 *   and reintroduce this defect for Québec and every US state.
 *
 * What this INCLUDES is then a judgement the declarations already made: the
 * Dutch loonheffing counts whole (wage tax and national-insurance premiums
 * arrive on one line and cannot be split downstream — excluding it prints a
 * false 0.00, which is the defect), and both Italian addizionali count (they
 * are income taxes on the same base; the old list counted IRPEF alone and
 * understated every Italian payslip).
 *
 * A new pack is covered on the day it registers: its income-tax components
 * are `taxable_income`-assessed deductions by construction (the fixpoint
 * needs that declaration to re-derive them), so they land in this set with
 * no generic-layer edit. The payslip YTD subquery
 * (web/lib/pdf-templates/values.ts) is the consumer; it once carried a
 * five-key CA/US literal here and printed YTD tax 0.00 for nine packs.
 */
export function incomeTaxWithholdingSystemKeys(): readonly string[] {
  const keys = new Set<string>();
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    for (const component of packStatutoryComponents(pack.country)) {
      if (component.kind === "deduction" && component.assessedOn === "taxable_income") {
        keys.add(component.systemKey);
      }
    }
  }
  return [...keys].sort();
}

/**
 * System keys of every statutory EMPLOYEE SOCIAL-INSURANCE contribution,
 * derived from the pack declarations — never a hand-maintained key list.
 *
 * The predicate is `kind === "deduction"` and `assessedOn === "earnings"`,
 * the exact complement of {@link incomeTaxWithholdingSystemKeys} over the
 * statutory deduction set, and each half is load-bearing:
 *
 * - `deduction` (not `employer_contribution`, not `credit`) keeps the figure
 *   to amounts withheld from the employee's pay. The employer shares ride the
 *   same system keys (CPP, EI, QPIP, INPS, PRSI …) but accrue at employer
 *   cost — counting them would overstate the withholding — and the Italian
 *   refundable credits (`ti_payout`, `somma_payout`) INCREASE net, so counting
 *   them would understate it.
 * - `earnings` (not `taxable_income`) keeps income-tax withholding OUT.
 *   The two sets are disjoint and jointly exhaustive over every statutory
 *   deduction: a component the packs declare as withheld from pay lands in
 *   exactly one of the two buckets, so no withheld money is invisible and
 *   none is counted twice.
 *
 * What this INCLUDES is then a judgement the declarations already made:
 * CPP/CPP2, EI and QPIP (Québec parental insurance — the register's old
 * `cpp_fica`/`ei` factor buckets dropped it entirely, so real withheld money
 * never appeared), NIC, PRSI, USC, the four ZUS contributions, INPS, the six
 * French cotisations, the four German Sozialversicherung branches, Japan's
 * pension and health, Spain's four Seguridad Social lines, Brazil's INSS,
 * Singapore's CPF employee share, and US Social Security / Medicare (both
 * tranches). Australia and the Netherlands correctly contribute NOTHING:
 * their packs declare no earnings-assessed employee deduction (PAYG and
 * loonheffing are income-tax withholding), so an empty per-pack slice is
 * the true figure, not a silent zero.
 *
 * A new pack is covered on the day it registers: its employee social
 * contributions are `earnings`-assessed deductions by construction (the
 * fixpoint needs that declaration to re-derive them), so they land in this
 * set with no generic-layer edit. The payroll register's `cpp_fica` and
 * `ei` columns (packages/reports, bound at the report catalog) are the
 * consumers: `ei` counts {@link eiColumnSystemKeys}, `cpp_fica` counts the
 * structural complement. The register once carried a CA/US factor literal
 * (`C + C2 + SS + MED + MED2` and `EI`) that printed 0.00 for eleven packs
 * and dropped QPIP everywhere — never restore one.
 */
export function employeeSocialInsuranceSystemKeys(): readonly string[] {
  const keys = new Set<string>();
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    for (const component of packStatutoryComponents(pack.country)) {
      if (component.kind === "deduction" && component.assessedOn === "earnings") {
        keys.add(component.systemKey);
      }
    }
  }
  return [...keys].sort();
}

/**
 * System keys the payroll register counts in its EI column: `ei` and `qpip`.
 *
 * This pair is a STATED RULE, not a derivation, and it is documented as one
 * because the alternative — pretending the declarations choose it — would be
 * the load-bearing-prose defect (a claim about an absent mechanism). No
 * pack attribute distinguishes an "EI-family" contribution: slots are a
 * per-pack vocabulary, sequences order within a pack, and nothing marks a
 * contribution short-term versus pension. So the declarations support one
 * social bucket ({@link employeeSocialInsuranceSystemKeys}), while the
 * register — its `CPP / FICA (employee)` and `EI (employee)` labels frozen
 * by owner ruling — keeps two columns. Splitting one derived bucket across
 * two frozen jurisdiction labels needs a rule, and this is it:
 *
 * - `ei` keeps legacy continuity: the old column read the EI factor, so EI
 *   stays EI.
 * - `qpip` joins it as the mandated fold: Québec parental insurance was in
 *   NEITHER register bucket, a silent drop of real withheld money corrected
 *   in this same change. EI is its truthful home, not CPP/FICA: QPIP is
 *   Québec's EI-system counterpart (the CA pack maps both slots to the same
 *   `eiPayableAccountId` fallback, declares them adjacently at sequences
 *   140/150, and Québec employees pay reduced EI precisely because QPIP
 *   covers parental benefits).
 * - Everything else in the derived social set lands in `cpp_fica` by
 *   STRUCTURAL COMPLEMENT (the binder subtracts this pair from the full
 *   set), never by enumeration: a present or future pack's contributions
 *   are visible in one of the two columns with no per-pack configuration,
 *   and a future short-term-insurance contribution defaulting to `cpp_fica`
 *   is mislabelled but VISIBLE — the failure this rule refuses is
 *   invisibility, not imperfect taxonomy under frozen labels.
 *
 * The binder refuses an `ei` key outside the derived social set, so this
 * pair can never count money the declarations do not put in the bucket.
 */
export function eiColumnSystemKeys(): readonly string[] {
  return ["ei", "qpip"];
}

// ---------------------------------------------------------------------------
// The jurisdiction chain, resolved ONCE
// ---------------------------------------------------------------------------

/**
 * The invariant fifteen files each assumed independently, declared here and
 * asserted in one place:
 *
 *     employee country ⟹ subsidiary country ⟹ run currency ⟹ filing account
 *
 * Every link was previously re-derived at the point of use, and every
 * re-derivation defaulted to Canada when it did not like the answer
 * (`emp.country === "US" ? "US" : "CA"`, `coalesce(prof.country, 'CA')`,
 * `province ?? "ON"`). A mixed CA/US tenant therefore produced Canadian CPP,
 * EI and Ontario income tax on an employee of a US legal entity, denominated
 * in USD, filed under a CRA program account — with no error anywhere, because
 * every one of those defaults was individually reasonable.
 *
 * The chain is resolved once per run and once per employee, and any
 * disagreement is a named refusal. It is never repaired by picking a side:
 * both sides are somebody's configuration, and guessing which one is wrong is
 * how the wrong money got withheld in the first place.
 */

/**
 * Every country pack an org may install, in registry order — packs flagged
 * `installable: false` (in development, superseded) are known to validation
 * but refused for install. The single source behind the settings API, the
 * setup wizard, and the onboarding pack cards: one function, never a
 * per-surface copy of the list.
 */
export function installablePayrollCountries(): string[] {
  return Object.values(PAYROLL_COUNTRY_PACKS)
    .filter((pack) => pack.installable)
    .map((pack) => pack.country);
}

/**
 * Installable packs as (country, name) pairs, for any surface that LISTS packs
 * to a person. Prefer this over `installablePayrollCountries()` there: a
 * surface handed only codes has nothing to show but codes, which is how eight
 * countries came to render as "GB"/"DE"/"FR" beside "Canada".
 */
export function installablePayrollPacks(): { country: string; name: string }[] {
  return Object.values(PAYROLL_COUNTRY_PACKS)
    .filter((pack) => pack.installable)
    .map((pack) => ({ country: pack.country, name: pack.name }));
}

/**
 * Display name for one region code under one pack — what pickers and labels
 * show a person. Reads the pack's own `regions.regionNames` declaration and
 * nothing else: no per-country branch, no locale lookup. The `?? region` is
 * a render-time last resort only — coverage is enforced by the
 * region-labels test, so it is unreachable for declared packs, and an
 * undeclared name fails there rather than rendering as a bare code that
 * reads as deliberate.
 */
export function payrollRegionLabel(country: string, region: string): string {
  const names = payrollPack(country).regions.regionNames;
  return names[region] ?? region;
}

/** The pack for a country, or a refusal naming the packs that do exist. */
export function payrollPack(country: string): PayrollCountryPack {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) {
    throw new PayrollJurisdictionError(
      `no payroll country pack for ${country || "(unset)"} — payroll is implemented for `
      + `${Object.keys(PAYROLL_COUNTRY_PACKS).join(", ")}`,
    );
  }
  return pack;
}

/** Resolve a component reporting category on its pay date; no current-year fallback. */
export function resolvePayrollStatutoryReportingCode(
  country: string,
  category: string | null | undefined,
  payDate: string,
): PayrollStatutoryReportingCode | null {
  if (category == null) return null;
  const matches = (payrollPack(country).statutoryReportingCodes ?? []).filter((entry) =>
    entry.category === category
      && entry.effectiveFrom <= payDate
      && (entry.effectiveTo == null || payDate < entry.effectiveTo));
  if (matches.length !== 1) {
    throw new PayrollPackError(
      `pay component reporting category "${category}" has ${matches.length === 0 ? "no" : "multiple"} `
      + `tax-form code mappings in the ${country} pack effective on ${payDate}; update the pack's `
      + "effective-dated statutory reporting declaration before calculating this payroll",
    );
  }
  return matches[0]!;
}

/** Narrow a stored country string to a pack, refusing anything else. */
export function payrollCountry(value: string | null | undefined): PayrollCountry {
  return payrollPack(value ?? "").country;
}
