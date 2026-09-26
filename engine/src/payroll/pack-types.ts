/** Payroll pack declarations: slots, components, identifiers, holidays, jurisdictions, remittance schedules. Split from packs.ts (pure moves only). */
import type { PAYROLL_COUNTRY_PACKS } from "./pack-registry"
import { type ControlAccountRole } from "../records/control-accounts.ts"
import { db } from "../platform/db.ts"
import type { PayrollPackFilings } from "./filing-registry.ts"
import type { LaborComplianceFileFormat, PayrollPackConstruction } from "./labor-compliance.ts"
import { type PayrollPackCertificates } from "./certificates.ts"
import { type PayrollPackReciprocity } from "./reciprocity.ts"
import { type PayrollPackWithholding } from "./withholding-jurisdictions.ts"
import type { PayrollEmployeeFact } from "./employee-facts.ts"
import { type PayrollEmployerFact } from "./employer-facts.ts"
import type { PayrollPackRates } from "./statutory-rates.ts"
import type { PayrollEmployerLevyContext, PayrollEmployerLevyFactors, PayrollStatutoryComputeContext, PayrollWorkAllocation } from "./statutory-context.ts"
import type { PayrollTaxYearSupport } from "./tax-years.ts"

/**
 * What a statutory amount is computed FROM. This is the property — and the
 * ONLY property — that decides whether the amount must be recomputed when a
 * deduction changes, which is what the deduction-protection fixpoint in
 * `calculateStub` needs to know.
 *
 * - `earnings` — assessed on gross / pensionable / insurable earnings or on
 *   hours. Protection only ever changes DEDUCTIONS, so an earnings-assessed
 *   amount is invariant across passes and is computed exactly once: WCB/WSIB,
 *   EHT, FUTA, SUTA, employer FICA, employer CPP/EI/QPIP — and also EMPLOYEE
 *   CPP, CPP2, EI and QPIP, which T4127 computes from pensionable income (PI)
 *   and insurable earnings (IE) and which no factor-F/F2/U1 deduction reduces.
 * - `taxable_income` — assessed on income AFTER pre-tax deductions, so a
 *   pre-tax protected order moves it and it must be re-derived on every pass.
 *   Income tax (CRA factors A → T) and US FIT only.
 *
 * Getting this wrong is silent money: a levy wrongly declared `earnings` goes
 * stale against the deductions actually taken, and one wrongly declared
 * `taxable_income` is recomputed and re-pushed every pass (project splits
 * included). The engine asserts the `earnings` half of the claim after the
 * loop converges rather than trusting it.
 */
export type PayrollAssessedOn = "earnings" | "taxable_income";

/**
 * Where a statutory component's accrued amount GOES — the remittance question,
 * answered per component the same way `assessedOn` answers the recomputation
 * question. Required, so a pack cannot add a levy the remittance module has to
 * guess about:
 *
 * - `tax_authority`    — remitted to the pack's statutory remittance vendor
 *   (the org-configured party named by the pack's
 *   `remittanceVendorSettingsKey`; unassigned when the pack declares none).
 * - `external`         — remitted, but to a per-component destination
 *   (`pay_components.remittance_party_id`): WCB boards, provincial ministries,
 *   state agencies. Unassigned until the org configures the party.
 * - `internal_accrual` — an internal liability that is NEVER remitted to
 *   anyone (vacation accrual: the money is owed to the employee and settles
 *   through a payout, not a remittance). Excluded from the remittance summary
 *   entirely; treating it as remittable withholding would raise a real vendor
 *   bill for money nobody is owed.
 */
export type PayrollRemittanceTreatment = "tax_authority" | "external" | "internal_accrual";

/**
 * How the pack's statutory engine must treat a RETROACTIVE payment — the
 * difference paid now for periods that were already paid at a lower rate.
 *
 * This is a jurisdictional fact, and it is genuinely not the same everywhere.
 * The CRA's T4127 has a whole method for it (Method 2, "retroactive pay
 * increase": tax the amount as a bonus, not as period income) and Revenu
 * Québec's TP-1015 Appendix 2 says the same for Québec; the IRS treats it as
 * supplemental wages under Pub 15-T. Other jurisdictions require a retro
 * amount to be RE-SPREAD over the periods it relates to and taxed as though it
 * had been paid then, which is a completely different number.
 *
 * - `non_periodic`  — taxed by the pack's non-periodic / bonus / supplemental
 *   method: the amount is not annualized as though the employee received it
 *   every period. This is what the `nonPeriodic` line flag already means and
 *   what T4127 factor B and Pub 15-T's supplemental path already implement, so
 *   declaring it wires to the conformance-tested engine rather than to
 *   anything new.
 * - `periodic`      — taxed as ordinary income of the period it is PAID in
 *   (annualized with the rest of the cheque).
 *
 * REQUIRED on every pack. A pack that inherits another jurisdiction's answer
 * for this withholds the wrong tax on the single largest off-cycle payment
 * most employees ever receive, and nothing downstream can tell.
 */
export type PayrollRetroactiveTreatment = "non_periodic" | "periodic";

/** A treatment's declared tax base, including jurisdiction-specific wage bases. */
export type PayrollCoreTaxBaseKey = "income" | "nonPeriodic" | "pensionable" | "insurable";
export type PayrollStateTaxBaseKey = `state:${string}:${"income" | "nonPeriodic"}`;
export type PayrollTaxBaseKey = PayrollCoreTaxBaseKey | PayrollStateTaxBaseKey;
export type PayrollTaxBases = Record<PayrollCoreTaxBaseKey, string>
  & Partial<Record<PayrollStateTaxBaseKey, string>>;

/**
 * One pre-tax treatment in a pack's vocabulary: a `pay_components.tax_treatment`
 * value the pack's law gives meaning, plus WHICH bases it reduces.
 *
 * "Pre-tax" is not one thing — a deduction reduces SOME bases and not
 * others, and which ones is jurisdiction law. Salary-sacrificed amounts
 * reduce the PAYG base but not the superannuation guarantee base; a 401(k)
 * elective reduces FIT but not social security or Medicare; an RPP/RRSP
 * contribution reduces T4127 factor F but neither CPP nor EI. A generic
 * boolean would move every base at once and ship a plausible-looking wrong
 * number, so each declaration names its legs.
 *
 * Convention, so combined-base arithmetic stays exact: a treatment that
 * reduces the income-tax base declares `reduces: ["income"]`; a recognized
 * deduction with no statutory tax-base effect can declare an empty list. The generic
 * layer subtracts tagged lines from the income leg in full; an engine that
 * taxes bonuses jointly adds the raw `nonPeriodic` leg back (the IE
 * pattern: taxable pay is gross less pension, priced as reduced income plus
 * untouched non-periodic pay). No treatment in the set reduces
 * `pensionable` or `insurable` — a treatment that did would move a social
 * insurance base, which is exactly the wrong-money case this vocabulary
 * exists to prevent by declaration.
 */
export interface PayrollDeductionTreatment {
  /** `pay_components.tax_treatment` value (`salary_sacrifice`, `pension_f`, …). */
  key: string;
  /** English fallback label for the component dialog; the UI prefers `labelKey`. */
  label: string;
  /**
   * `admin.setup.options.*` message key where a catalogued translation
   * exists (the Canadian factor treatments). Absent for treatments whose
   * only name is the pack's own English label.
   */
  labelKey?: string;
  /** Operator help: what the treatment is and which bases it reduces. */
  help: string;
  /** The generic bases a line carrying this treatment reduces. */
  reduces: readonly PayrollTaxBaseKey[];
}

/** An effective-dated tax-form code for a classified pay component. */
export interface PayrollStatutoryReportingCode {
  category: string;
  componentKind?: string;
  taxTreatment?: string;
  formCode: string;
  boxCode: string;
  code: string;
  label: string;
  effectiveFrom: string;
  effectiveTo?: string;
  source: string;
}

/**
 * What an employer-aggregate levy's base accumulates. The generic layer sums
 * non-accrual earning lines by flag — `gross` is every earning, `taxable` is
 * the taxable subset — reusing the same line flags the per-employee engine
 * already stamps, so a pack cannot invent a base the run cannot see.
 */
export type PayrollAggregateBaseSource = "gross" | "taxable" | "pensionable";

/**
 * Whose total the base is: the whole employer (`org`) or the employer's
 * payroll in one region (`region`, the stub's employment region). An
 * exemption shared across regions is several region levies, not one org
 * levy — the declaration says which.
 */
export type PayrollAggregateScope = "org" | "region";

/**
 * WHEN the levy is assessed. `per_run` accrues on every stub; `annual`
 * accrues nothing per run and settles at year end, because its defining
 * input (a qualifying spend) is unknowable until then. The generic layer
 * enforces the distinction rather than trusting it.
 */
export type PayrollAggregateTiming = "per_run" | "annual";

/** One marginal band: base up to `upTo` prices at `percent`; null tops out. */
export interface PayrollAggregateBand {
  upTo: string | null;
  percent: string;
}

/** The band table for one employer class, selected by an org-scope flag. */
export interface PayrollAggregateClassBands {
  flag: string;
  bands: readonly PayrollAggregateBand[];
}

/**
 * How the rate resolves from the employer aggregate — the question the
 * tenant-entered EHT slot answers with "you tell us", made declarative:
 *
 * - `flat_percent` — a published percent (a labour-standards levy);
 * - `marginal_bands` — the rate is a function of the employer's total base,
 *   priced marginally so the annual total is order-independent (a
 *   payroll-bracketed health levy). `classBands` specialize by employer
 *   class; `bands` is the default when no class matches;
 * - `tenant_slot` — the agency cannot publish it (an experience- or
 *   payroll-dependent rate), so the employer configures it per year in the
 *   named org- or region-scope slot and the generic layer reads it back.
 */
export type PayrollAggregateRate =
  | { kind: "flat_percent"; percent: string }
  | {
    kind: "marginal_bands";
    bands?: readonly PayrollAggregateBand[];
    classBands?: readonly PayrollAggregateClassBands[];
  }
  | { kind: "tenant_slot"; slotKey: string; percentField: string };

/**
 * The annual room a levy prices against:
 *
 * - `none` — every stub's base prices whole (an unthresholded levy);
 * - `employer_allowance` — the first `amount` of employer base in scope is
 *   sheltered; the stub prices what lands above the remaining shelter (an
 *   exemption, a threshold);
 * - `per_employee_cap` — each employee's first `amount` of base prices; the
 *   stub prices what fits under the remaining headroom (a per-employee
 *   earnings cap with year-to-date carry);
 * - `accruing_allowance` — an annual allowance held as a subsidiary-scoped
 *   employer fact (`factKey`) that accrues 1/12 per elapsed tax month: the
 *   stub pays the cumulative amount due on the whole year-to-date base less
 *   what is already paid. `yearStartMonth`/`yearStartDay` open the agency's
 *   tax year (April 6 for HMRC). Missing fact value refuses by name through
 *   the fact's own required flag.
 *
 * A shelter and a ceiling consume in opposite directions; the assessor
 * implements both and the threshold test pins the difference.
 */
export type PayrollAggregateAllowance =
  | { kind: "none" }
  | { kind: "employer_allowance"; amount: string }
  | { kind: "per_employee_cap"; amount: string }
  | {
    kind: "accruing_allowance";
    /** Subsidiary-scoped employer fact holding the annual allocated share. */
    factKey: string;
    /** Tax-year start the monthly accrual counts from (HMRC: April 6). */
    yearStartMonth: number;
    yearStartDay: number;
  };

/**
 * One contribution levied on the employer aggregate. The stub lines it
 * produces ride a seeded employer-contribution component under `systemKey`
 * (the component's `assessedOn` must be `earnings` — enforced at wiring, so
 * a levy can never point at a deduction-sensitive component and drift
 * across fixpoint passes). `factorKey` namespaces the YTD factors the room
 * computation reads back.
 */
export interface PayrollEmployerAggregateLevy {
  /** Stable identity: the commit-fence key and the finding trail. */
  key: string;
  label: string;
  /** Seeded component system key the stub lines post under. */
  systemKey: string;
  /** Stub line text. */
  description: string;
  /** Stub presentation order. */
  sequence: number;
  base: {
    source: PayrollAggregateBaseSource;
    scope: PayrollAggregateScope;
    /**
     * Per-period floor subtracted from a pensionable-source base before it
     * accumulates (a secondary-threshold-style floor: weekly/monthly/annual
     * figures from the year's transcribed tables, prorated to the penny for
     * other periodicities). Required exactly when source is pensionable.
     */
    periodFloor?: { weekly: string; monthly: string; annual: string };
  };
  timing: PayrollAggregateTiming;
  rate: PayrollAggregateRate;
  allowance: PayrollAggregateAllowance;
  /**
   * Org-scope slot holding the employer-class flags `classBands` selects
   * on. Required when `classBands` is present — classes that can never
   * match are refused, not silently unpriced.
   */
  classSlotKey?: string;
  /**
   * Employer-class exclusion (a sector the statute does not levy): the
   * org-scope slot flag that zeroes the assessment.
   */
  excludedBy?: { slotKey: string; flagField: string };
  /**
   * Qualifying-spend offset (training spend against a payroll levy).
   * Annual timing only: spend is unknowable until year end.
   */
  offset?: { kind: "tenant_spend"; slotKey: string; amountField: string };
  /**
   * Pack opening-field key carrying this employee's pre-adoption base for a
   * `per_employee_cap` levy, resolved through the pack's own
   * `openingYtdFields` registry — the generic layer never names a column.
   */
  employeeOpeningFieldKey?: string;
  factorKey: string;
}

/**
 * One statutory component of a pack: what the engine seeds, what it pushes a
 * line under, what that line is assessed on, and where the withheld amount is
 * remitted. `assessedOn` and `remittance` are required, so a pack cannot add
 * a statutory component without answering either question.
 */
export interface PayrollStatutoryComponent {
  /** pay_components.code. */
  code: string;
  /** pay_components.name. */
  name: string;
  /** pay_components.system_key — the key the engine pushes the line under. */
  systemKey: string;
  /**
   * What the line IS. `deduction` withholds (decreases net),
   * `employer_contribution` accrues at employer cost (net-neutral), and
   * `credit` pays a refundable employment credit the employer reclaims from
   * the tax authority (INCREASES net). A credit is earnings-assessed,
   * computed from gross, pushed once and never re-derived by the protection
   * fixpoint; `remittance: "tax_authority"` because the employer reclaims it.
   */
  kind: "deduction" | "employer_contribution" | "credit";
  /** pay_components.sequence — presentation order on the stub. */
  sequence: number;
  assessedOn: PayrollAssessedOn;
  remittance: PayrollRemittanceTreatment;
  /**
   * Region-scoped override of the pack's `tax_authority` remittance vendor:
   * for a stub whose employment region matches a key here, the withheld
   * amount is remitted to the vendor named by THAT settings key instead of
   * the pack's `remittanceVendorSettingsKey`.
   *
   * This is a second `remittanceVendorSettingsKey`-style declaration, not a
   * routing rule in the remittance module: the CA pack declares that a QC
   * employee's QPP/QPP2/QPIP (both shares) are remitted to Revenu Québec on
   * TPZ-1015.R (`rqRemittancePartyId`), never to the CRA vendor — the same
   * amounts for every other province go to the CRA. The remittance summary
   * consumes the declaration per stub province and knows no jurisdiction.
   */
  regionalRemittanceVendorSettingsKeys?: Readonly<Record<string, string>>;
}

export interface PayrollStatutorySlot {
  key: string;
  /** The seeded components this slot's account applies to. */
  components: readonly PayrollStatutoryComponent[];
  /** Pre-pack orgs.settings.payroll key honoured as a read fallback. */
  legacySettingsKey?: string;
  /**
   * The chart account role this slot's liability defaults to — a ROLE, never
   * an account number: the pack names what the money IS (withheld payroll
   * tax sits in the payroll-deductions account) and the org's own chart
   * resolves which account that is. Applied only where the operator has not
   * mapped the slot yet (an explicit mapping always wins), so a pack can
   * never silently re-point a configured liability. Absent = the slot stays
   * unmapped until the operator maps it, exactly as today.
   */
  liabilityAccountRole?: ControlAccountRole;
  /**
   * WHERE the slot is live — the account-side appliesWhen, the same concept
   * as the rate slot's `regions` (which it mirrors wherever a rate slot
   * exists for the levy). Absent = every region the pack knows. A slot that
   * does not apply is INERT for a run there: no line and no account demand,
   * so an Ontario-only employer is never asked to map the Québec HSF or
   * Revenu Québec accounts.
   *
   * The demand side fail-closes: a null or unknown region still demands,
   * because demanding an account mapping is safe and skipping money is not.
   */
  regions?: readonly string[];
}

/**
 * The countries a payroll pack exists for.
 *
 * OPEN on purpose: it is exactly the registry's keys, so declaring a pack is
 * what makes its country expressible and no generic-layer edit is needed for
 * the ninth pack. (The registry is annotated `Record<string, ...>`, so this
 * resolves to `string`; narrowing a stored value to a pack is the runtime
 * job of `payrollPack`, which refuses by name.)
 *
 * Widening this is a PACK, not a cast: `emp.country === "US" ? "US" : "CA"`
 * (what `calculateStub` used to do) turns every unrecognised value — including
 * a country whose pack was never written — into Canada, and Canadian
 * withholding on a foreign employee is silent, unrecoverable, wrong money.
 */
export type PayrollCountry = keyof typeof PAYROLL_COUNTRY_PACKS;

/**
 * What the two generic contributory earning FLAGS mean under this pack.
 *
 * `pay_components.pensionable` and `pay_components.insurable` are
 * jurisdiction-free column names for two jurisdiction-specific accumulators,
 * and every pack overloads them: for the CRA they are CPP pensionable income
 * and EI insurable earnings; for the IRS they are FICA wages and FUTA/SUI
 * wages. That overloading used to be a code comment three files apart from the
 * code that relied on it. It is now a REQUIRED declaration: a new pack must
 * say what each flag accumulates (or refuse the flag outright) before its
 * components can be seeded, instead of silently inheriting whichever meaning
 * the reader happened to assume. The declaration is asserted at seed time.
 */
export interface PayrollContributoryBases {
  /** The statutory base the `pensionable` earning flag accumulates. */
  pensionable: string;
  /** The statutory base the `insurable` earning flag accumulates. */
  insurable: string;
}

/**
 * One contribution program with its OWN insurable/pensionable base — a
 * program the pack prices and files separately from the two classic flags
 * (Québec's QPIP parental program beside CPP/QPP and EI).
 *
 * The base accumulates from per-earning-type applicability the pack declares
 * (each earning line carries the program key when the type contributes to
 * it; absent means included, matching the sibling flags' default-true), is
 * stored per stub period under `stubFactorKey`, and is read back by the
 * pack's slips capped at the program's own maximum. Never approximated from
 * another program's base: EI-excluded earnings can be QPIP-insurable and the
 * reverse, and the model must let them differ.
 *
 * OPTIONAL: a pack whose every program rides the two classic flags declares
 * nothing. No other pack declares one today.
 */
export interface PayrollContributionProgram {
  /** Program code, e.g. `qpip`. Keys earning-line applicability and the opening carry-in. */
  key: string;
  /** Operator label, e.g. `QPIP insurable earnings`. */
  label: string;
  /** What the base is, in the program's own statutory words. */
  help: string;
  /** Stub `factors` key carrying the period's base, e.g. `IE_QPIP`. */
  stubFactorKey: string;
}

/**
 * An opening wage-base carry-in scoped to one filing account (see
 * `accountOpeningBases` on the pack). A state unemployment account is keyed
 * by EIN, a federal W-2 program by nothing, and a W-2 program that prints
 * one slip per state by the two-letter state code: one row per account means
 * the carry-in can never land on the wrong slip, and an employer with two
 * SUI accounts in one state cannot file either until the history is
 * attributed to the exact account.
 */
export interface PayrollAccountOpeningBase {
  /** Program code, e.g. `us_sui`, `us_w2_state`. Keys the carry-in. */
  key: string;
  /** Operator label, e.g. `SUI insurable wages carried in under this SUI account`. */
  label: string;
  /** What the carry-in is, in the program's own statutory words. */
  help: string;
  /** Filing-account `program_type`, e.g. `us_state_sui`. */
  filingProgramType: string;
  /**
   * True when one row is carried per state (SUI, state W-2 slips) and the
   * region must be a two-letter state code; false for federal EIN-level
   * programs, which cannot carry a state.
   */
  requiresRegion: boolean;
  /**
   * Legacy `payroll_opening_balances` text field this declaration replaces for
   * W-2 reporting. While both carry amounts the carry-in screen refuses the
   * save and names the replacement; once the legacy column reads zero the
   * account rows are the only source and the legacy amount pays nothing.
   */
  replacesLegacyField?: string;
}

/**
 * One second-order opening year-to-date amount a country pack declares for
 * mid-year adopters (see `openingYtdFields` on the pack). The generic
 * opening-balances layer — the field list, the money validation, the
 * import/export columns, the grid — iterates these declarations and never
 * names a pack's columns; the pack's own statutory computation reads its
 * history back through the same descriptors.
 */
export interface PayrollOpeningYtdField {
  /** camelCase API / import-file key, unique across all packs' declarations. */
  key: string;
  /** payroll_opening_balances column holding the amount. */
  column: string;
  /** English fallback label; the UI localizes by key and falls back to this. */
  label: string;
  /** What the operator copies out of the prior provider's YTD report. */
  help: string;
  /**
   * Key of another opening field this amount cannot exceed (a part-to-whole
   * bound, e.g. bonus-attributed history against the bonuses). The generic
   * validation refuses a row that breaks it, which is how a transposed
   * spreadsheet column shows up. Absent when the amount has no whole.
   */
  ceilingKey?: string;
}

/**
 * A boolean `employee_payroll_profiles` fact the pack's statutory engine reads
 * that NO employee-filed certificate sets — so the certificate declarations
 * cannot carry it and the profile editor would otherwise have nowhere to offer
 * it. The CA pack declares none: its exemptions (CPP, EI, income tax) are TD1
 * flag fields. The US pack declares FICA/FUTA exemption here because no form
 * exists for them (there is no "Form FICA-EXEMPT", so a certificate declaration
 * would have to lie in its `form`).
 */
export interface PayrollProfileExemptionFlag {
  /** The `employee_payroll_profiles` boolean column holding the answer. */
  column: string;
  /** English fallback label; the UI localizes by column and falls back to this. */
  label: string;
  /** Operator help, rendered beside the checkbox. */
  help: string;
}

/**
 * The employee identifier a country pack's payroll runs on: the SIN, SSN,
 * NINO, PPSN, Steuer-IdNr, NIR, DNI/NIE, codice fiscale, NRIC/FIN, My Number,
 * PESEL, CPF, TFN or BSN.
 *
 * The profile API used to strip every non-digit and then demand exactly nine
 * of them (`String(body.sin ?? '').replace(/\D/g, '')` against `/^\d{9}$/`),
 * which mangled every alphanumeric identifier before judging it and refused
 * every non-9-digit one — ten of fourteen countries. Worse, digit-stripping
 * does not merely reject a valid French NIR, it CORRUPTS it: a Corsican
 * department (`2A`/`2B`) stripped of its letter is a different number. A
 * validator that silently transforms input before judging it is worse than
 * one that rejects, so the generic layer tests the value AS GIVEN against
 * the pack's own pattern and never a stripped derivative.
 *
 * Each pack declares its own length and character shape, and may also supply
 * an authority-backed semantic validator for a defined checksum or embedded
 * date. The generic layer enforces that validator without naming any
 * country's identifier rules.
 */
export interface PayrollEmployeeIdentifier {
  /**
   * The real local name — NINO, PPSN, Steuer-IdNr, NIR, DNI/NIE, codice
   * fiscale, NRIC/FIN, My Number, PESEL, CPF, TFN, SIN, SSN, BSN. Shown on
   * the profile editor and named in refusal messages, so an operator is
   * never asked for a "SIN/SSN" in a country that has neither.
   */
  label: string;
  /**
   * The format as a regex source for a FULL match (the generic layer anchors
   * it: `^(?:pattern)$`). Case-insensitive; the value is uppercased before
   * testing so `2a` and `2A` are the same Corsican department. Interior
   * separators appear here only where the authority's own presentation uses
   * them (HMRC's `QQ 12 34 56 A`, the `000.000.000-00` CPF) — never by
   * stripping the input first.
   */
  pattern: string;
  /**
   * The shape in words, for refusal messages and the editor placeholder:
   * "2 letters, 6 digits, 1 letter". No checksum is ever described here
   * unless the pattern enforces it.
   */
  formatHelp: string;
  /**
   * A real-format example, locale-neutral, shown as the editor placeholder:
   * `QQ 12 34 56 C`, `1234567T`, `RSSMRA85T10A562S`. Every pack's example
   * must satisfy its own pattern (asserted in
   * engine/src/payroll/employee-identifier.test.ts).
   */
  example: string;
  /**
   * Whether payroll requires one at all. A pack whose employees may
   * lawfully be paid without one declares false. This never refuses a save
   * — it feeds the missing-identifier warnings with `neededFor`, so a save
   * without one still lands and the warnings demand it where a filing needs
   * it.
   */
  requiredForPayroll: boolean;
  /**
   * What it is needed FOR, where that matters — the RTI submission, the
   * W-2, the DSN — or null when no filing needs it. This is the GATE for
   * the year-end and run-readiness identifier warnings: they fire only when
   * the pack both requires the identifier AND names a filing that needs it,
   * so a pack with no filing to feed warns about nothing while one that
   * names one still warns. Country is never the question.
   */
  neededFor: string | null;
  /**
   * The authority's own statement of the format, quoted — never a blog, and
   * never another vendor's documentation.
   */
  citation: string;
  /**
   * Optional country-specific validation beyond the declared text shape.
   * A pack uses this when its authority requires a checksum or semantic date.
   */
  validator?: {
    validate: (canonical: string) => boolean;
    refusalReason: string;
  };
  /**
   * True when the value is digits only (mobile numeric keyboard hint). A
   * pack whose authority presents the value with separators declares false.
   */
  numericEntry: boolean;
}

/**
 * The result of judging one raw identifier against one pack's declaration.
 * `saved` is the value to seal (trimmed, uppercased) when valid; null means
 * the operator sent empty and the stored value should be cleared. `message`
 * is the refusal worth showing when invalid.
 */
export interface EmployeeIdentifierVerdict {
  readonly valid: boolean;
  readonly saved: string | null;
  readonly message: string | null;
}

export interface PayrollCountryPack {
  country: PayrollCountry;
  /**
   * The country's name, in English, for any surface that shows a pack to a
   * person. REQUIRED, and deliberately data rather than copy.
   *
   * The setup UI used to read its card title from an i18n key per pack
   * (`payroll.settingsPage.packs.<key>.title`) and fall back to the bare
   * country code, on the reasoning that "a new pack is a translation edit".
   * Only CA and US ever got that key written, so eight countries shipped
   * rendering as "GB", "DE", "FR" beside "Canada" and "United States" —
   * the fallback was silent and looked deliberate. A country's name is a
   * fact about the country, so the pack states it and no surface can show a
   * raw code by omission. `CountryTaxPackDefinition.name` already works this
   * way; this makes the two pack families symmetric.
   *
   * Localized names remain an i18n OVERRIDE where a locale wants one — the
   * UI prefers the message and falls back to this, never to the code.
   */
  name: string;
  /**
   * The employee identifier the pack's payroll runs on (see
   * `PayrollEmployeeIdentifier`). REQUIRED, for the same reason `name` is —
   * a pack that does not answer is a pack whose answer somebody guessed,
   * and the guess was a hardcoded Canadian nine digits. The generic profile
   * layer, the sealed-storage writer, and the readiness warnings branch on
   * this declaration and nothing else: no country code, no digit count, no
   * country name anywhere outside the pack files.
   */
  employeeIdentifier: PayrollEmployeeIdentifier;
  installable: boolean;
  statutorySlots: readonly PayrollStatutorySlot[];
  /**
   * orgs.settings.payroll key holding the vendor party that `tax_authority`
   * components are remitted to (the CRA remittance vendor for the CA pack).
   * `null` is a declaration that the pack has no single statutory remittance
   * vendor configured this way — its withholdings surface unassigned until
   * per-component destinations are set. REQUIRED, so a new pack answers the
   * question instead of inheriting another authority's vendor.
   */
  remittanceVendorSettingsKey: string | null;
  /**
   * Destination remittance schedules: per-vendor frequencies, selection
   * bands and due-date rules as DATA (see `PayrollRemittanceSchedule`). The
   * generic remittance layer dates a bill from the schedule governing its
   * destination vendor and never from a jurisdiction branch — a destination
   * with no declared schedule keeps the legacy registration-timetable
   * behaviour only when its pack allows the fallback below, and otherwise
   * refuses instead of borrowing another authority's timetable.
   * OPTIONAL: a pack with no agency of its own to remit to on its own
   * timetable declares none (the US pack's federal deposits ride EFTPS).
   */
   remittanceSchedules?: readonly PayrollRemittanceSchedule[];
  /**
   * Whether destinations this pack declares (its vendor keys) but for which
   * no schedule governs the period may fall back to the legacy
   * registration-based timetable (the CRA remitter-type function) instead of
   * refusing. Absent/false = refuse: a declared but undated destination must
   * never borrow another authority's timetable (see remittanceGroupDueDate).
   * Declared ONLY by the pack whose authority owns that timetable — today
   * the CA pack, while the CRA schedule handoff (F-f7-001) still leaves the
   * legacy function the live path for destinations the schedule does not
   * yet govern.
   */
  allowsRegistrationTimetableFallback?: boolean;
  /**
   * region code → the `tax_administration` calendar key whose holidays move
   * a statutory remittance deadline for a payroll worked WHOLLY in that
   * region, when the country's tax authority keeps a regional calendar that
   * differs from its national one.
   *
   * Canada's is the CRA's Québec calendar (`CA-CRA-QC`): Saint-Jean-Baptiste
   * Day is a holiday there and the Civic Holiday is not, so a Québec-only
   * payroll's deadline lands on a different day from an Ontario one. That is
   * a fact about the CRA, and the shared remittance layer used to hold it as
   * `province === "QC"` with a boolean option named `quebec` — which made one
   * country's regional exception the generic layer's vocabulary and gave
   * every other pack a Canadian answer it never asked for.
   *
   * REQUIRED, and `{}` is the answer for a country whose authority keeps one
   * calendar nationwide. An omitted declaration would read as `{}` anyway,
   * so requiring it is the difference between a pack that says "no region
   * differs here" and a pack whose author never considered the question.
   */
  remittanceRegionalCalendars: Readonly<Record<string, string>>;
  /**
   * How a RETROACTIVE payment is taxed here (see the type). REQUIRED: retro
   * pay is a generic concept with a jurisdictional answer, and a pack that
   * inherits another's answer withholds the wrong tax on the largest
   * off-cycle payment most employees ever receive.
   */
  retroactivePayTreatment: PayrollRetroactiveTreatment;
  /** What the generic pensionable/insurable flags mean here. See the type. */
  contributoryBases: PayrollContributoryBases;
  /**
   * Contribution programs with their own bases (see the type). Absent means
   * the pack's every program rides the two classic flags.
   */
  contributionPrograms?: readonly PayrollContributionProgram[];
  /**
   * Filing-account-scoped opening wage-base carry-ins (see the type).
   * Absent means the pack's openings need no per-account attribution.
   */
  accountOpeningBases?: readonly PayrollAccountOpeningBase[];
  /**
   * pay_components.tax_treatment for EMPLOYEE-paid union dues, or null when
   * the pack's statutory engine gives dues no tax treatment at all.
   *
   * 'union_dues' is a T4127 factor-U1 key: the CRA deducts dues from taxable
   * income. Stamping it on every employee-paid fringe in every country made a
   * CRA factor the world's default — a pack whose engine has no such concept
   * must declare `null` and its dues lines carry no treatment.
   */
  employeeUnionDuesTaxTreatment: string | null;
  /**
   * The pack's pre-tax deduction vocabulary (see `PayrollDeductionTreatment`).
   * REQUIRED, like `contributoryBases`: the component dialog offers exactly
   * these treatments for the pack's employees, and the generic layer computes
   * the reduced bases from them — a treatment key the pack does not declare
   * is inert on its runs, so a foreign factor can never leak across packs.
   * A pack with no transcribed pre-tax treatment declares `[]` and says so;
   * silence is not a statement.
   */
  deductionTreatments: readonly PayrollDeductionTreatment[];
  /** Tax-form reporting mappings keyed by component classification category. */
  statutoryReportingCodes?: readonly PayrollStatutoryReportingCode[];
  /**
   * The ONE currency the pack's statutory engine computes, remits and files
   * in. T4127 produces CAD and Pub 15-T produces USD; there is no currency
   * argument anywhere in either engine, so a run denominated in anything else
   * is filing one currency's numbers under another's return.
   */
  statutoryCurrency: string;
  /**
   * How the pack's TAX year is defined. `payDate.slice(0, 4)` is the calendar
   * year, which is right for the CRA and the IRS and wrong for HMRC (6 April)
   * and the ATO (1 July) — so the question is answered by the jurisdiction,
   * declared once, even where both current packs answer "calendar".
   */
  taxYear: PayrollTaxYearDefinition;
  /** Jurisdictions inside the country, and which ones the engine can withhold for. */
  regions: PayrollRegionCoverage;
  /**
   * The pack's jurisdictions: which statutory holidays each one observes and
   * how it computes holiday pay. Declared here for the same reason the
   * statutory slots are — a holiday is a jurisdictional FACT, so it belongs in
   * the one place the jurisdiction layer is declared, never in engine code and
   * never in a tenant's configuration table.
   */
  jurisdictions: readonly PayrollJurisdiction[];
  /**
   * A work-triggered alternate-day-off entitlement the pack's statute grants
   * (see `PayrollRemembranceAlternateDayRule`) — Nova Scotia's Remembrance
   * Day Act is the one declared anywhere. OPTIONAL: absent means the pack
   * declares no work-triggered grant, and the generic seed layer provisions
   * no alternate-day bank for it. The seed reads this declaration and no
   * country code, so a second jurisdiction's grant is a pack edit, never a
   * branch in the generic layer.
   */
  alternateDayGrant?: PayrollRemembranceAlternateDayRule;
  /**
   * The pack's filing declaration: filing-account program types, the
   * separation-payment component mapping, and the year-end filings (label,
   * population, electronic-file builder, issue workflow). LAZY — the filings
   * modules sit in an import cycle with the year-end builders, so the
   * declaration must not be dereferenced at module-evaluation time.
   */
  filings: () => PayrollPackFilings;
  /**
   * The statutory rates the EMPLOYER supplies, and the scope each one varies
   * by — org-wide, per region, or per filing account
   * (engine/src/payroll/statutory-rates.ts). REQUIRED: a pack that stores an
   * experience-rated or per-region levy at org level can hold exactly one of
   * the several real values, and nothing in the product can tell.
   */
  statutoryRates: PayrollPackRates;
  /**
   * Which TAX YEARS the pack's statutory tables are transcribed for, and how
   * the next edition is scaffolded (engine/src/payroll/tax-years.ts).
   * REQUIRED: refusing an untranscribed year is right, but only a declaration
   * lets the product say so BEFORE a payroll calculates.
   */
  taxYears: PayrollTaxYearSupport;
  /**
   * The certificates the pack's employees file to set their own withholding
   * (engine/src/payroll/certificates.ts). LAZY, like `filings`: the declaration
   * modules import the pack's rate and engine modules and would be dereferenced
   * mid-evaluation if the pack held the value.
   *
   * REQUIRED, for the same reason `statutoryRates` and `taxYears` are — a pack
   * that does not answer is a pack whose answer somebody guessed. A country
   * whose employees file no withholding certificate at all declares an empty
   * list, which is a statement; silence is not.
   */
  certificates: () => PayrollPackCertificates;
  /**
   * Boolean profile facts the pack's engine reads that no employee-filed
   * certificate sets (see the type). OPTIONAL: absent or empty offers none.
   * Rendered by the profile editor as checkboxes beside the certificate flag
   * fields, so a pack's statutory exemptions are all declared in one of
   * exactly two places — never a third list in UI code.
   */
  profileExemptionFlags?: readonly PayrollProfileExemptionFlag[];
  /**
   * The `emp[...]` facts the pack's statutory engine reads that no other
   * declaration carries (see `PayrollEmployeeFact`). REQUIRED: a pack whose
   * engine reads no employee fact declares `[]`, which is a statement;
   * silence is not. Four packs read facts no surface produces (PL birth
   * year, ES grupo/situación/año, JP hyōjun/kaigo, BR dependentes) while
   * `installable: true` — the declaration that gap is refused at
   * authoring time by the employee-facts conformance test, and what
   * `payable` derives from. A claimed producer must resolve in the typed
   * certificate / profile-column declarations, never in prose.
   */
  employeeFacts: readonly PayrollEmployeeFact[];
  /** Effective-dated legal-employer values required by this pack. */
  employerFacts: readonly PayrollEmployerFact[];
  /**
   * Profile-column values the pack DERIVES from facts it already collects,
   * keyed by `employee_payroll_profiles` column — today, only the PL birth
   * year off the PESEL (see `pl/pesel.ts`). OPTIONAL: most packs derive
   * nothing. The profile API reads this generically: a derived value
   * PREFILLS a blank field on save, while a supplied value that contradicts
   * it refuses naming both — two sources that disagree are the
   * parallel-sources-of-truth the product forbids. A derivation that cannot
   * answer (no identifier on file, an uncited century band) yields nothing,
   * and the declared field then stands alone.
   */
  deriveEmployeeFacts?: (input: {
    /** The pack's sealed employee identifier, unsealed — or null when none. */
    identifier: string | null;
  }) => readonly { column: string; value: string }[];
  /**
   * Which regions levy income tax, what sits below them, and how each one
   * treats its residents' out-of-region wages
   * (engine/src/payroll/withholding-jurisdictions.ts). REQUIRED: this is the
   * declaration `resolveWithholding` refuses on, and a pack that omits it
   * cannot be asked the cross-border question at all — which is how a Québec
   * resident working in Ontario was silently withheld Ontario only.
   */
  withholding: () => PayrollPackWithholding;
  /**
   * Interstate / interprovincial reciprocity
   * (engine/src/payroll/reciprocity.ts). OPTIONAL, and the only one of the
   * three that is: "this country has no such agreements" is a legitimate and
   * common answer, and an absent declaration resolves exactly as an empty one —
   * to "no agreement", which withholds the work region. Canada declares none.
   */
  reciprocity?: () => PayrollPackReciprocity;
  /**
   * Phase 8 — earnings-assessed employer-only levies the pack declares in its
   * statutory slots (WCB/EHT for CA). Absent when the pack levies none.
   */
  applyEmployerLevies?: (
    ctx: PayrollEmployerLevyContext,
  ) => Promise<PayrollEmployerLevyFactors>;
  /**
   * Employer-aggregate levies: contributions assessed on the EMPLOYER as a
   * whole — its total payroll in scope, its sector or employer class, a
   * year-versioned allowance or cap, an offsetting qualifying spend — rather
   * than on any one employee's earnings. Absent when the pack levies none
   * (both built-in packs absent today; the per-employee path above is
   * untouched by this channel).
   *
   * The declaration is DATA the generic layer computes
   * (engine/src/payroll/employer-aggregate.ts): what the base is and how the
   * rate resolves from it. The year arrives as an argument because every
   * figure here is published per tax year, and the declaration REFUSES a
   * year it has not transcribed — the same doctrine as the tax-year
   * editions. LAZY (a closure over the tax year), like `openingYtdFields`.
   */
  employerAggregateLevies?: (
    taxYear: number,
  ) => readonly PayrollEmployerAggregateLevy[];
  /**
   * Request the common schedule/work-line hour facts in the statutory context.
   * A pack opts in only when its law prices an obligation against paid hours.
   */
  statutoryHours?: { basis: "contractual-plus-worked-extra" };
  /**
   * Second-order opening year-to-date the pack's statutory engine reads for a
   * mid-year adopter: history the BASE opening columns cannot express because
   * it is attributed to lump-sum payments (T4127 F5B, TP-1015 CSB1) or counts
   * withheld dollars rather than wages (US FICA). OPTIONAL, like
   * `applyEmployerLevies`: absent when the pack's engine reads nothing beyond
   * the base fields, in which case the generic layer offers no extra columns.
   *
   * LAZY (a closure), like `filings` and `certificates`: the declaration
   * lives in the pack's country module, which the engine's country
   * computations also import for their SQL — a value here would be
   * dereferenced mid-evaluation.
   */
  openingYtdFields?: () => readonly PayrollOpeningYtdField[];
  /**
   * Phase 9 — one re-runnable statutory pass over the current line set.
   * REQUIRED on every installable pack. The money in the context obeys the
   * contract documented on `PayrollStatutoryComputeContext` (canonical
   * numeric(19,4), always 4 decimals from the pipeline): parse it with
   * money.ts, never a pack-local decimal regex.
   */
  computeStatutory: (
    ctx: PayrollStatutoryComputeContext,
  ) => Promise<Record<string, string>>;
  /** Optional pack-owned producer of verified work allocations for jurisdiction rules. */
  loadWorkAllocations?: (
    tx: Pick<typeof db, "execute">,
    input: {
      orgId: string;
      employeePartyId: string;
      employmentId: string | null;
      periodStart: string;
      periodEnd: string;
      taxYear: number;
      documentId: string;
      currentWages: string;
    },
  ) => Promise<PayrollWorkAllocation[]>;
  /**
   * Rate slots the run must not REQUIRE at one scope point, decided by the
   * pack from recorded account facts. OPTIONAL: absent when every declared
   * `refuse` slot always applies, in which case the generic layer requires
   * them all, exactly as today.
   *
   * A waiver is never silence: it answers only on a RECORDED fact (US SUI
   * waives `us_sui` for a recorded reimbursable or School Employees Fund
   * account, whose liability the run does not price), and nothing recorded
   * waives nothing — so the gate and the compute pass cannot disagree about
   * what is missing.
   */
  waivedRateSlots?: (
    tx: Pick<typeof db, "execute">,
    input: {
      orgId: string;
      region: string | null;
      filingAccountId: string | null;
      payDate: string;
    },
  ) => Promise<readonly string[]>;
  /**
   * The pack's annual settlement for one tax year: the year-end
   * recomputation and its settlement in the final pay
   * (engine/src/payroll/annual-settlement.ts). OPTIONAL: absent when the
   * pack settles nothing, in which case the generic layer never calls and
   * the monthly path is untouched by construction.
   *
   * LAZY per-edition closure (like `employerAggregateLevies`): the
   * algorithm may differ by year, and a year the pack has not transcribed
   * resolves to null — which runs nothing, never a guessed program.
   */
  annualSettlement?: (
    taxYear: number,
  ) => import("./annual-settlement.ts").PayrollAnnualSettlement | null;
  /**
   * The statutory engine's published name, for the stub calculation trace
   * heading (F-t08-012): "T4127" for the CRA pack, "Pub 15-T" for the IRS
   * pack. REQUIRED: the trace heading names the filing regime the numbers
   * were computed under, and a hardcoded heading names the wrong country.
   */
  statutoryEngineLabel: string;
  /**
   * Human names for the statutory trace factors, keyed by the factor keys
   * the pack's engine actually emits onto the stub (the trace keys, the
   * compute-statutory extras, the pack's own return-map keys). REQUIRED,
   * for the same reason `name` is: the trace UI falls back to the raw key,
   * and it ALSO prints the raw key beside the label — so a pack that stays
   * silent renders every factor as the code echoed twice ("MD_TAXABLE
   * MD_TAXABLE"), which reads as deliberate. A factor's name is a fact
   * about the publishing agency's notation, so the pack states it.
   *
   * Each country's entries live beside the code that traces them (the US
   * state engines, Pub 15-T, T4127, TP-1015, each pack's compute module)
   * and are aggregated here — never a flat map in the web layer, which
   * cannot tell California's CA_TAX from Canada's CA or Delaware's
   * DE_WITHHELD from Germany's DE.
   */
  factorLabels: Readonly<Record<string, string>>;
  /**
   * Names for factor keys no static map can enumerate: the US pack's
   * `SIT_<code>` / `LIT_<code>` stub-line mirrors, whose codes include
   * operator-entered sub-region certificates (an Ohio school district, a
   * Michigan city). OPTIONAL, and absent exactly when the pack emits no
   * such open-ended keys. Returns the label, or null to fall back to the
   * raw key. The generic resolver tries `factorLabels` first.
   */
  describeFactor?: (key: string) => string | null;
  // HR-13 begin: labor-compliance declarations (HRM construction
  // compliance). OPTIONAL on both: a pack with no labor-compliance
  // reporting concept declares no files, and a pack with no
  // construction carve-outs declares no construction — the generic layer
  // lists whatever is declared and refuses generation by name when a
  // pack declares none (absent === empty), never inheriting another
  // pack's form. Present implies non-empty (see
  // engine/src/payroll/labor-compliance.test.ts). LAZY like
  // filings/certificates: the builders sit beside the pack's engine
  // modules, so the declaration must not be dereferenced at
  // module-evaluation time.
  laborComplianceFiles?: () => readonly LaborComplianceFileFormat[];
  construction?: PayrollPackConstruction;
  // HR-13 end
}

/**
 * The trace label for one stub factor under one pack: the pack's declared
 * `factorLabels` entry, else its `describeFactor` answer, else the region
 * name the pack already declares when the key IS a region code, else the raw
 * key. The UI and the coverage guard both resolve through this — never
 * through a web-layer map — so a newly traced factor with no declaration
 * renders raw in exactly one place and fails the guard in exactly one place.
 *
 * The `regionNames` step is not a fallback in the apologetic sense: a bare
 * region code is a factor whose name the pack has ALREADY stated, so reading
 * it here is the same declaration the region pickers read through
 * `payrollRegionLabel`. Without it a pack that names all fifty states still
 * traced "AL", because the name lived in a field this resolver did not
 * consult — one declaration, two readers, only one of them looking.
 */
export function factorLabelForPack(
  pack: PayrollCountryPack,
  key: string,
): string {
  return (
    pack.factorLabels[key] ??
    pack.describeFactor?.(key) ??
    pack.regions.regionNames[key] ??
    key
  );
}

// ---------------------------------------------------------------------------
// The tax year, and the regions the pack can actually withhold for
// ---------------------------------------------------------------------------

/**
 * When the pack's tax year opens, and which calendar year names it.
 *
 * `calendar` is the degenerate case of the fiscal rule (opens 1 January, named
 * for the year it opens), so there is one code path and adding HMRC's 6 April
 * or the ATO's 1 July is data, not a branch.
 */
export interface PayrollTaxYearDefinition {
  /** Documentation of intent; both shapes run through the same arithmetic. */
  basis: "calendar" | "fiscal";
  /** 1–12. */
  startMonth: number;
  /** 1–31. */
  startDay: number;
  /**
   * Which end of a straddling year names it. HMRC's 2026/27 year opens
   * 6 April 2026 and is named for the year it OPENS; the ATO's 2025/26 year
   * opens 1 July 2025 and is named for the year it CLOSES.
   */
  namedBy: "opening_year" | "closing_year";
}


/**
 * Which jurisdictions inside the country the pack's engine can actually
 * withhold income tax for.
 *
 * The pack draws the line between "this region does not exist" and "this
 * region exists and we do not implement it" — two different failures that must
 * both be loud, and neither of which may be approximated by falling back to a
 * region that IS implemented. The US pack already refused an unsupported state
 * inline in `calculateStub`; this moves that good precedent to where the CA
 * pack has to answer the same question about Quebec.
 */
export interface PayrollRegionCoverage {
  /** What the jurisdiction is called, for the refusal message. */
  label: string;
  /** Every code an employee may legitimately carry. */
  known: readonly string[];
  /**
   * Display name per known code ("NSW" → "New South Wales"), for every
   * picker and label that shows a region to a person. REQUIRED, like
   * `known` itself: `regions.known` is codes-only because refusals and
   * storage key on codes, but a surface handed only codes has nothing to
   * show but codes — which is how AU state pickers rendered NSW/VIC/QLD
   * while the AU pack already knew the full names in another field. A new
   * pack (or a new region on an existing pack) without a name for every
   * known code fails the region-labels coverage test, never a review.
   */
  regionNames: Readonly<Record<string, string>>;
  /** Those whose income tax the pack's engine computes end to end. */
  supported: readonly string[];
  /** Why a known-but-unsupported region is refused; `{region}` is substituted. */
  unsupportedReason: string;
  /** Region-specific reason, where the general one would be misleading. */
  unsupportedReasons?: Readonly<Record<string, string>>;
}


// ---------------------------------------------------------------------------
// Statutory holidays — the jurisdictional calendar
// ---------------------------------------------------------------------------

/**
 * How a holiday's calendar date is derived for a given year.
 *
 * Most statutory holidays are NOT fixed dates: "the first Monday in
 * September", "the Monday preceding May 25", "the Friday before Easter". A
 * hardcoded date table goes wrong silently the first year nobody updates it,
 * so the rule itself is the declaration and the date is computed.
 *
 * - `fixed`          — the same calendar day every year (Canada Day, Dec 25).
 * - `nth_weekday`    — the nth <weekday> of a month; `nth: -1` counts back
 *                      from the end (US Memorial Day = last Monday in May).
 * - `weekday_before` — the last <weekday> strictly before month/day
 *                      (Victoria Day and Quebec's National Patriots' Day are
 *                      the Monday preceding May 25).
 * - `easter_offset`  — days relative to Easter Sunday, computed from the
 *                      Gregorian computus (Good Friday = -2, Easter Monday
 *                      = +1). This is the only holiday family whose date
 *                      cannot be expressed against the civil calendar at all.
 */
export type PayrollHolidayRule =
  | { kind: "fixed"; month: number; day: number }
  | { kind: "nth_weekday"; month: number; weekday: number; nth: number }
  | { kind: "weekday_before"; month: number; day: number; weekday: number }
  | { kind: "easter_offset"; days: number };

/**
 * What happens when the derived date lands on a weekend.
 *
 * - `none` — the holiday is observed on the day it falls. This is the correct
 *   declaration for a provincial employment-standards calendar: the ESA does
 *   not MOVE the public holiday when it lands on a non-working day, it grants
 *   a substitute day off, and the holiday-pay entitlement still attaches to
 *   the real date.
 * - `next_monday` — a Saturday or Sunday holiday is observed on the following
 *   working day, skipping any day already taken by another holiday (Christmas
 *   on a Sunday pushes Boxing Day to the Tuesday). Canada Labour Code s. 195.
 * - `nearest_weekday` — Saturday is observed on the preceding Friday and
 *   Sunday on the following Monday. 5 U.S.C. 6103(b), the US federal rule.
 */
export type PayrollHolidayObservance = "none" | "next_monday" | "nearest_weekday";

export interface PayrollHoliday {
  /** Stable identity, used by tenant overrides. Never renamed. */
  key: string;
  name: string;
  rule: PayrollHolidayRule;
  observance: PayrollHolidayObservance;
  /**
   * True when the jurisdiction does NOT require the day to be observed and an
   * employer may elect it (Boxing Day in Ontario, Heritage Day in Alberta,
   * Easter Monday). Optional days are NOT observed until a tenant override
   * turns them on, so the default calendar is exactly the statutory minimum.
   */
  optional?: boolean;
  /** First year the day exists (Truth and Reconciliation Day, Juneteenth). */
  from?: number;
  /** Last year the day exists, inclusive. */
  until?: number;
}

/** A dated statutory payment triggered by working a day outside the general-holiday calendar. */
export interface PayrollWorkTriggeredHoliday {
  key: string;
  name: string;
  rule: PayrollHolidayRule;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** A pack-declared employer fact that exempts the employer from this Act. */
  employerExemptionFact?: string;
  qualifying: { lastAndFirstScheduledShift: boolean };
  payment:
    | {
        kind: "holiday_pay_plus_overtime";
        overtimeRate: string;
        minimumHours: "half_normal_day";
      }
    | { kind: "alternate_paid_day" };
}

/**
 * WHICH days of a window a statute counts — the predicate, declared.
 *
 * Three statutes, three genuinely different sentences, and every one of them
 * decides whether a real employee is paid:
 *
 *  - `worked` — the employee actually worked the day. New Brunswick's averaging
 *    arm ("the days on which the employee WORKED during the thirty calendar
 *    days"), the territories' thirty-days-worked service test, Alberta's
 *    average daily wage.
 *  - `worked_or_earned_wages` — British Columbia, ESA s. 44 and s. 45: "worked
 *    or earned wages for 15 of the 30 calendar days preceding the statutory
 *    holiday", and the same measure again as the denominator of the average
 *    day's pay. The Branch's own interpretive guideline is explicit that this
 *    takes in days of paid annual vacation, paid sick days required by the Act,
 *    and other paid statutory holidays falling in the window. An employee who
 *    spent the fortnight before Canada Day on paid vacation worked no days and
 *    earned wages on every one of them.
 *  - `entitled_to_pay` — Nova Scotia, Labour Standards Code s. 42(1): the
 *    employee "received or was ENTITLED TO RECEIVE pay" for fifteen of the
 *    thirty days. Broader again: it reaches pay the employer owes and has not
 *    yet paid, not only pay that was earned.
 *
 * They are declared separately even where a given data model cannot yet tell
 * two of them apart, because the statute is the fact and the engine's ability
 * to see it is not. Collapsing them into one value would make the day the
 * model improves a re-reading of every jurisdiction instead of a widening of
 * one resolver.
 */
export type PayrollHolidayDayCounting =
  | "worked"
  | "worked_or_earned_wages"
  | "entitled_to_pay";

/**
 * Where a lookback window ENDS — and it is not the same sentence everywhere.
 *
 *  - `day_before` — "the four weeks immediately preceding the general holiday".
 *    The window ends the day before the holiday itself. Alberta, Saskatchewan,
 *    Manitoba, New Brunswick, Newfoundland, Nova Scotia, Prince Edward Island
 *    and British Columbia's thirty calendar days are all worded this way.
 *  - `week_before` — "the four-week period immediately preceding the WEEK in
 *    which the general holiday occurs". The window ends on the last day of the
 *    week BEFORE the holiday's own week, so the part-week the holiday sits in
 *    is excluded entirely. The Canada Labour Code s. 196, Ontario s. 24(1)(a)
 *    ("the four work weeks before the work week with the public holiday"),
 *    Quebec s. 62 ("the four complete weeks of pay preceding the week of the
 *    holiday"), Yukon s. 30(2) and the two territories are all worded this way.
 *
 * The two differ by up to six days of earnings, and for anyone whose pay varies
 * that difference is money. `weekStartsOn` is the statute's default week: 0 is
 * Sunday, which the Canada Labour Code fixes (s. 166) and Ontario uses when no
 * employer work week is selected. A pack may name its effective-dated employer
 * fact for an employer-selected boundary.
 */
export type PayrollHolidayLookbackBoundary =
  | { kind: "day_before" }
  | { kind: "week_before"; weekStartsOn: number; employerWeekStartsOnFact?: string };

/**
 * How a day's statutory holiday pay is computed from prior earnings. This is a
 * statutory FACT per jurisdiction and it varies in both the window and the
 * divisor, so it is declared, never hardcoded to whichever province was
 * implemented first.
 *
 * - `fixed_divisor` — earnings over the lookback divided by a constant. The
 *   constant encodes a notional five-day week (Ontario, Quebec and the Canada
 *   Labour Code all divide four weeks of wages by 20), so a part-timer is
 *   pro-rated rather than paid a full day.
 * - `average_day` — earnings over the lookback divided by the number of days
 *   actually worked in it (British Columbia, Alberta). A zero denominator is a
 *   refusal, never a zero payment.
 * - `percent_of_earnings` — a straight percentage of the lookback's earnings
 *   (Saskatchewan's 5%). Arithmetically 1/20 but declared as the statute
 *   words it, because the statute is what an auditor reads.
 *
 * All three derive the day from a LOOKBACK over prior earnings, which is why
 * they share a type: the engine can always compute them from committed stubs
 * and nothing else.
 */
export type PayrollHolidayPayLookbackBasis =
  | {
      /** Current hourly rate × average hours worked per day in the window. */
      kind: "average_hours_day";
      lookbackWeeks: number;
    }
  | {
      kind: "fixed_divisor";
      divisor: number;
      lookbackWeeks: number;
      /** Commission earners get a longer, flatter window in several statutes. */
      commission?: { divisor: number; lookbackWeeks: number; minWeeksEmployed: number };
    }
  | {
      kind: "average_day";
      lookbackDays?: number;
      lookbackWeeks?: number;
      /**
       * WHICH days the denominator counts. REQUIRED, because the statutes do
       * not agree and the difference is the size of the day's pay: New
       * Brunswick divides by "the days on which the employee WORKED", while
       * British Columbia divides by "the number of days the employee worked or
       * earned wages" — which its own guideline says includes paid vacation
       * days and other paid statutory holidays. Dividing the same wages by two
       * different denominators is two different answers, so the denominator is
       * declared rather than assumed.
       */
      counting: PayrollHolidayDayCounting;
    }
  | { kind: "percent_of_earnings"; percent: string; lookbackWeeks: number };

/**
 * The fourth basis is not a lookback at all.
 *
 * - `normal_day` — the wages of ONE NORMAL WORKING DAY: the hours the employee
 *   is normally scheduled to work on a working day, at their regular rate.
 *   Several statutes word the entitlement exactly that way, and no quantity of
 *   prior earnings can produce it. A four-day compressed week is forty hours
 *   and a TEN-hour normal day; dividing four weeks of wages by 20 pays eight.
 *
 *   Note it is the normal WORKING day and not the calendar day the holiday
 *   fell on. Every statute that words the entitlement this way also grants a
 *   substitute day off with pay when the holiday lands on the employee's day
 *   off, so what is owed is one normal day either way — never the zero hours of
 *   whichever weekday the holiday happened to occupy.
 *
 *   It reads `work_schedules` (engine/src/payroll/work-schedules.ts), and where that is
 *   silent it REFUSES by name: there is no default working day, and inventing
 *   an eight-hour one produces a number indistinguishable on the stub from a
 *   correct one.
 *
 *   `whenIrregular` is the statute's OWN fallback, not a convenience. Every
 *   jurisdiction that words the entitlement as a normal day also says what to
 *   do when the employee has no normal day — "where the hours of work or wages
 *   vary, …" — and that arm is always an ordinary lookback. Declaring both arms
 *   keeps the whole rule in one place, and keeps a varying-hours employee from
 *   being refused for a fact the statute already answers.
 *
 *   Omitted only where the statute states NO fallback — old Prince Edward
 *   Island leaves the varying-hours rate to an inspector's discretion
 *   (RSPEI 1988 c E-6.2 s. 10(4)), which is not a computable arm. The engine
 *   refuses that case by name rather than inventing a formula, so an omitted
 *   fallback is a transcription of silence, never a gap.
 */
export type PayrollHolidayPayBasis =
  | PayrollHolidayPayLookbackBasis
  | {
      kind: "normal_day";
      /**
       * Where the statute confines the normal-day measure to employees working
       * at least the jurisdiction's STANDARD hours, and puts everyone below it
       * on `whenIrregular` even when their pattern is perfectly regular.
       *
       * Declared as a number of scheduled hours per week because that is how
       * the statutes that do this express it. Omitted where the split turns
       * only on whether the hours vary, which is most of them.
       */
      minWeeklyHours?: number;
      whenIrregular?: PayrollHolidayPayLookbackBasis;
    };

/**
 * The lookback arm of any basis — itself, or a `normal_day`'s fallback.
 * Undefined where a `normal_day` rule declares no fallback: callers that
 * need a window degrade to the holiday date itself, and callers that need an
 * amount refuse by name. Both are total on the absence — no caller branches
 * on which jurisdiction omitted it.
 *
 * The lookback window is loaded unconditionally, because a `normal_day` rule
 * cannot know until it has resolved the employee's schedule whether it will
 * need it. One accessor, so no caller re-derives the unwrapping and gets it
 * subtly different.
 */
export const holidayPayLookbackBasis = (
  basis: PayrollHolidayPayBasis,
): PayrollHolidayPayLookbackBasis | undefined =>
  basis.kind === "normal_day" ? basis.whenIrregular : basis;

/** Which earnings the lookback base includes. Overtime is excluded almost
 *  everywhere; vacation pay and prior holiday pay are not. */
export interface PayrollHolidayPayInclusions {
  overtime: boolean;
  vacationPay: boolean;
  /** Statutory holiday pay already paid inside the lookback window. */
  holidayPay: boolean;
}

/** The tests an employee must pass to be entitled to the day. */
export interface PayrollHolidayQualifying {
  /** Calendar days of employment before the holiday (BC: 30). */
  minEmploymentDays?: number;
  /** Some statutes apply the service test only when the employee does not work the holiday. */
  minEmploymentDaysWhenUnworked?: boolean;
  /**
   * Days inside a window (BC: 15 of the 30 days before). `counting` is
   * REQUIRED and is the whole test: "worked 15 of 30" and "worked or earned
   * wages on 15 of 30" are different sentences in different Acts, and an
   * employee on paid vacation passes one and fails the other.
   */
  minDaysWorkedInWindow?: { days: number; ofDays: number; counting: PayrollHolidayDayCounting };
  /**
   * The "last and first" rule: an employee absent WITHOUT the employer's
   * consent on the last scheduled shift before or the first after loses the
   * day. Declared so the entitlement can be denied deliberately; the engine
   * never infers the absence, because it cannot infer consent.
   */
  lastAndFirstScheduledShift: boolean;
  /**
   * A statute's OWN alternative to the day-count arm above. British Columbia
   * ESA s. 44(b) qualifies an employee who worked under a s. 37 averaging
   * agreement at any time in the window, whatever their day count. Declared
   * on the rule so the alternative is a transcription, not a special case;
   * the engine still never infers the agreement — the caller asserts it.
   */
  averagingAgreementAlternative?: boolean;
}

/** Pay for hours actually worked on the holiday, on top of the day's pay. */
export interface PayrollHolidayPremium {
  multiplier: string;
  /** BC pays double time past 12 hours worked on the holiday. */
  overtimeAfterHours?: number;
  overtimeMultiplier?: string;
  /** Whether the day's holiday pay is owed IN ADDITION to the premium. */
  plusHolidayPay: boolean;
}

export interface PayrollHolidayPayRule {
  /** The statute and section this rule is a transcription of. */
  citation: string;
  basis: PayrollHolidayPayBasis;
  include: PayrollHolidayPayInclusions;
  qualifying: PayrollHolidayQualifying;
  premium: PayrollHolidayPremium;
  /**
   * Where every lookback this rule uses ENDS — the pay window, and a
   * commission earner's longer window with it. REQUIRED: it was an
   * unstated constant of "the day before the holiday", which is right in eight
   * jurisdictions and wrong by up to six days of earnings in the other five.
   */
  lookbackEnds: PayrollHolidayLookbackBoundary;
  /**
   * Weekly cap for one occupation's unworked-holiday pay, applied AFTER the
   * basis prices the day. Absent everywhere the statute states no cap — the
   * engine never invents one.
   */
  weeklyCap?: PayrollOccupationWeeklyCap;
  /**
   * Occupations the statute excludes from holiday-pay entitlement outright,
   * keyed by the `statutory_occupation_class` value the employee answers —
   * the repealed Prince Edward Island Act's elect-to-work contracts
   * (RSPEI 1988 c E-6.2 s. 7(1)(e)) are the first. A member of a named class
   * is denied the day by name; an unanswered class fails the run closed;
   * any other class runs the general rule. Omitted where the statute names
   * no excluded class.
   */
  excludedOccupations?: Readonly<Record<string, PayrollHolidayExcludedOccupation>>;
}

/**
 * One occupation a holiday-pay rule excludes from entitlement, in the
 * statute's own words — the pack's declaration, never a hardcoded list in a
 * consumer. The engine denies a member the day (reason + citation on the
 * trace); the resolver refuses an unanswered class by name with the
 * profile/run remedy, exactly like an unanswered commission status.
 */
export interface PayrollHolidayExcludedOccupation {
  /** English class label, shown where no locale key exists. */
  label: string;
  /** The statute section imposing the exclusion. */
  citation: string;
  /** Why the class is not entitled, for the denial and the refusal. */
  reason: string;
}

/**
 * A weekly cap on one occupation's unworked-holiday pay: the shape of New
 * Brunswick ESA s. 21(2), and deliberately NOT part of the basis. The basis
 * prices the day; the cap then refuses to let that price push the week's
 * earnings above the trailing average.
 *
 * The occupation arrives as a presented profile value, compared here against
 * `occupationValue` — never resolved through a registry, because the only
 * registry that validates closed sets also demands a pack-local read the
 * generic engine has no honest place to put. The profile boundary validates
 * the closed set instead (see `occupationCapValues`); the engine refuses an
 * unrecorded class and skips any other value.
 */
export interface PayrollOccupationWeeklyCap {
  /**
   * Closed vocabulary for the class column under this rule — the capped
   * occupation plus the uncapped rest (there must be a storable answer for
   * an employee the cap does not touch, or every one of them refuses).
   */
  values: readonly string[];
  /** The one value of `values` this cap applies to. */
  cappedValue: string;
  /** Weeks of the trailing average ("the preceding four weeks"). */
  lookbackWeeks: number;
}

/**
 * One EDITION of a jurisdiction's holiday-pay formula — the same treatment
 * `engine/src/payroll/tax-years.ts` gives a pack's statutory tables, for the
 * same reason.
 *
 * Employment-standards formulas are amended, and a repealed Act still governs
 * the periods it was in force for. Prince Edward Island is the live case: SPEI
 * 2024 c 66 came into force on 2026-06-30 and replaced a regular day's pay with
 * a percentage, so a retroactive PEI run for a June 2026 period computed on the
 * new Act is simply wrong money. A single undated rule per jurisdiction cannot
 * say that, so a jurisdiction declares editions and the engine resolves the one
 * in force on the WORK DATE — the holiday's own date, never today.
 *
 * A date no edition covers is a REFUSAL, exactly as an unloaded tax year is:
 * "the statute governing this period has not been transcribed" and "the
 * jurisdiction requires nothing" must never produce the same payment.
 */
export interface PayrollHolidayPayEdition {
  /**
   * ISO date the edition comes into force, or NULL for "unbounded before".
   *
   * Required, and never omitted, because the two answers differ by a refusal.
   * `null` is an explicit assertion and not an absence: it says the pack
   * carries no earlier transcription for this jurisdiction and offers this one
   * for every earlier date — which is what every jurisdiction here did before
   * editions existed, stated out loud instead of assumed.
   */
  effectiveFrom: string | null;
  /** Last date the edition governs, inclusive; null while it is current. */
  effectiveTo: string | null;
  rule: PayrollHolidayPayRule;
}

/**
 * A work-triggered alternate-day-off entitlement: the shape Nova Scotia's
 * Remembrance Day Act takes, and deliberately NOT a PayrollHolidayPayRule.
 * A general-holiday rule pays cash on the holiday's own run; this one pays
 * nothing then and grants an employee-specific hours-bank entitlement to be
 * taken later. Declaring it as a holiday-pay rule would price the benefit on
 * November 11 itself — the exact defect this shape removes.
 */
export interface PayrollRemembranceAlternateDayRule {
  /** Ledger source key stamped on the granted movement (e.g. remembrance_day). */
  holidayKey: string;
  /** Fixed month/day the statute names — never substituted, never observed. */
  month: number;
  day: number;
  /** Days of the qualifying window on which wages must have been receivable. */
  qualifyingDays: number;
  /** Length of the qualifying window in calendar days, ending the day before. */
  qualifyingWindowDays: number;
  /** Which days count — the statute's own predicate, not "worked". */
  counting: PayrollHolidayDayCounting;
  /** Employer-fact key carrying the business class (see employer-facts). */
  businessClassFactKey: string;
  /** Business-class values exempt from granting. */
  exemptBusinessClasses: readonly string[];
  /**
   * Employment jurisdictions whose statute grants this alternate day, as
   * jurisdiction keys (e.g. "CA-NS"). The generic seed provisions the bank
   * wherever the pack declares the grant, but the bank accrues only under
   * these jurisdictions — readiness names it only for employees whose
   * resolved labour jurisdiction is in scope. A second jurisdiction's grant
   * extends this list; it is never a branch in the generic layer.
   */
  jurisdictions: readonly string[];
  citation: string;
}

/**
 * A jurisdiction inside a country pack: a province, a state, the federal
 * labour code, or a tax administration's own office calendar.
 *
 * `holidayPay: null` is a DECLARATION that the jurisdiction mandates no
 * statutory holiday pay at all (the US, where the FLSA requires no payment for
 * time not worked). It is not the same as a jurisdiction this pack does not
 * declare — that one throws. Silence and "no entitlement" must never be the
 * same value, because one of them is a bug and the other is the law.
 *
 * An empty edition list declares an untranscribed mandate and refuses payroll
 * by name before an incomplete calendar can suppress the holiday entirely.
 * A nonempty list carries editions in force over date ranges, resolved
 * against the holiday's own date. A jurisdiction whose formula has never been
 * amended within this pack's knowledge declares exactly one, with
 * `effectiveFrom: null`.
 */
export interface PayrollJurisdiction {
  key: string;
  name: string;
  /**
   * What KIND of calendar this is. `employment` calendars bind employers —
   * they are the ones statutory holiday pay reads, and the ones an undeclared
   * sibling jurisdiction is probed against. `tax_administration` calendars are
   * an authority's own office calendar (the CRA's, which carries Easter Monday
   * and the Civic Holiday no province's ESA lists); they move remittance due
   * dates and must never be mistaken for anyone's employment calendar.
   * REQUIRED, so the two families cannot be conflated by omission.
   */
  scope: "employment" | "tax_administration";
  /** The statute that lists the holidays. */
  citation: string;
  holidays: readonly PayrollHoliday[];
  holidayPay: readonly PayrollHolidayPayEdition[] | null;
  /** Statutory work-triggered payments that are not general holidays. */
  workTriggeredHolidays?: readonly PayrollWorkTriggeredHoliday[];
}
/**
 * One frequency's due-date rule, as DATA the generic remittance layer
 * interprets — never a jurisdiction branch in engine code. Three shapes cover
 * every fixed-date schedule either current pack needs:
 *
 * - `month_day` — day N of the month M months after the period's month
 *   (Revenu Québec monthly: the 15th of the following month).
 * - `quarter_day` — day N of the month M months after the quarter's end month
 *   (Revenu Québec quarterly: the 15th of the month following the quarter).
 * - `split_month` — the month is cut at `cutoffDay`: the first half is due
 *   `firstDueDay` of the same-or-offset month, the second half `secondDueDay`
 *   (Revenu Québec twice-monthly: 1st–15th due the 25th, 16th–end due the
 *   10th of next month).
 * - `quarter_month_working_days` — the month is cut into quarter-month
 *   periods (the 1st–7th, 8th–14th, 15th–21st, 22nd–month-end) and the period
 *   the date falls in is due `workingDays` WORKING days after that period's
 *   end, counted on the schedule's own calendar (the CRA's accelerated
 *   threshold 2: the 3rd working day after the quarter-month).
 *
 * A fixed-date deadline landing on a Saturday, Sunday or a holiday of the
 * schedule's declared calendar moves to the next business day — the one shift
 * sentence every fixed-date schedule shares, so it lives on the schedule, not
 * on each rule. A working-day-counted deadline needs no shift: counting
 * working days necessarily lands on a working day.
 */
export type RemittanceDueRule =
  | { kind: "month_day"; day: number; monthsAfterPeriodMonth: number }
  | { kind: "quarter_day"; day: number; monthsAfterQuarterEnd: number }
  | {
      kind: "split_month";
      cutoffDay: number;
      firstDueDay: number;
      firstDueMonthOffset: number;
      secondDueDay: number;
      secondDueMonthOffset: number;
    }
  | {
      kind: "quarter_month_working_days";
      /** Working days after the quarter-month period's end; at least 1. */
      workingDays: number;
    };

/**
 * One remittance frequency of a destination's schedule: the band of average
 * monthly remittance that selects it, and the due-date rule inside the band.
 * Amounts are decimal strings compared with the money helpers, never floats.
 */
export interface PayrollRemittanceFrequencyBand {
  /** Stable key, stored in org configuration (`frequencySettingsKey`). */
  frequency: string;
  /** Operator-facing label for setup and readiness surfaces. */
  label: string;
  /** Inclusive floor of the average-monthly-remittance band; absent = none. */
  averageMonthlyMin?: string;
  /** Exclusive ceiling of the band; absent = none. */
  averageMonthlyMaxExclusive?: string;
  due: RemittanceDueRule;
  /**
   * The statutory sentence carried onto the bill, so an operator sees WHY
   * the date is what it is. A `split_month` band names the first half here
   * and the second half in `ruleSecondHalf`.
   */
  rule: string;
  ruleSecondHalf?: string;
}

/**
 * A destination's remittance schedule, declared by the pack that remits to
 * it. The generic layer resolves it by the destination's vendor settings key
 * and dates the bill from it — the CRA schedule must never apply to a
 * destination with its own declaration.
 *
 * Effective-dated: `effectiveFrom` (inclusive) to `effectiveTo` (exclusive,
 * absent = in force) select the version governing a period-end date, so a
 * future agency change ships as a second version with a contiguous range and
 * never reinterprets history. Bills stamp the applied rule text at creation.
 */
export interface PayrollRemittanceSchedule {
  /** The vendor settings key whose configured party this schedule governs. */
  vendorSettingsKey: string;
  /** The receiving authority, shown on bills and readiness surfaces. */
  authority: string;
  /** Published sources for every rule — a reviewer verifies, never guesses. */
  sources: readonly string[];
  /** First period-end date (YYYY-MM-DD, inclusive) this version governs. */
  effectiveFrom: string;
  /** Last version boundary (YYYY-MM-DD, exclusive); absent = in force. */
  effectiveTo?: string;
  /**
   * The tax-administration jurisdiction key whose holidays move deadlines
   * (a `scope: 'tax_administration'` calendar — never an employment one).
   */
  calendar: string;
  /** orgs.settings.payroll key holding the org's frequency for this destination. */
  frequencySettingsKey: string;
  /** Frequency when the org configured none (the agency's new-employer rule). */
  defaultFrequency: string;
  frequencies: readonly PayrollRemittanceFrequencyBand[];
}

// ---------------------------------------------------------------------------
// Statutory remittance and posting — the pack declarations, resolved once
// ---------------------------------------------------------------------------

/**
 * ONE pack's remittance and legacy-account declarations folded into lookups
 * by system key, for that pack's own country. Never across packs: two
 * sovereign tax authorities routinely give the same withholding the same
 * system key (GB and IE both call theirs `paye`), and those are two correct
 * descriptions of two jurisdictions — not a disagreement to detect. Within
 * the pack, a system key two slots declare DIFFERENTLY is a refusal naming
 * the country, never a coin toss. Callers resolve country-first, from the
 * component row's own country.
 */
export interface StatutoryRemittanceDeclaration {
  /** System keys this pack declares `internal_accrual` — never remitted. */
  internalAccrualSystemKeys: readonly string[];
  /** systemKey → the pack's remittance-vendor settings key (null = none). */
  vendorSettingsKeyBySystemKey: ReadonlyMap<string, string | null>;
  /**
   * systemKey → { region → vendor settings key }: the component-declared
   * regional overrides of the pack vendor (QPP/QPIP → Revenu Québec for QC
   * stubs). Consulted per stub region BEFORE the pack-level vendor.
   */
  regionalVendorSettingsKeyBySystemKey: ReadonlyMap<string, Readonly<Record<string, string>>>;
  /** systemKey → the slot's pre-pack orgs.settings.payroll account key. */
  legacyLiabilitySettingsKeyBySystemKey: ReadonlyMap<string, string>;
}
