import { sql } from "drizzle-orm";
import {
  assertValidControlAccountMappings,
  type ControlAccountRecord,
  type ControlAccountRole,
  type OrgControlAccounts,
} from "../records/control-accounts.ts";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import type { PayrollPackFilings } from "./filing-registry.ts";
// HR-13 begin: labor-compliance declaration types (type-only; the
// declarations live in the pack country trees, never here).
import type {
  LaborComplianceFileFormat,
  PayrollPackConstruction,
} from "./labor-compliance.ts";
// HR-13 end
import { CA_PAYROLL_PACK } from "./canada/pack.ts";
import { US_PAYROLL_PACK } from "./us/pack.ts";
import { GB_PACK } from "./gb/pack.ts";
import { DE_PAYROLL_PACK } from "./de/pack.ts";
import { FR_PAYROLL_PACK } from "./fr/pack.ts";
import { IE_PAYROLL_PACK } from "./ie/pack.ts";
import { AU_PAYROLL_PACK } from "./au/pack.ts";
import { IT_PAYROLL_PACK } from "./it/pack.ts";
import { NL_PAYROLL_PACK } from "./nl/pack.ts";
import { ES_PAYROLL_PACK } from "./es/pack.ts";
import { SG_PAYROLL_PACK } from "./sg/pack.ts";
import { JP_PAYROLL_PACK } from "./jp/pack.ts";
import { PL_PAYROLL_PACK } from "./pl/pack.ts";
import { BR_PAYROLL_PACK } from "./br/pack.ts";
import {
  type PayrollPackCertificates,
  registerPayrollCertificateSource,
} from "./certificates.ts";
import {
  type PayrollPackReciprocity,
  registerPayrollReciprocitySource,
} from "./reciprocity.ts";
import {
  type PayrollPackWithholding,
  registerPayrollWithholdingSource,
} from "./withholding-jurisdictions.ts";
import type { PayrollEmployeeFact } from "./employee-facts.ts";
import type { PayrollPackRates, PayrollStatutoryRateSlot } from "./statutory-rates.ts";
import { payrollDraftTaxYears, payrollSupportedTaxYears } from "./tax-years.ts";
import { taxYearFor } from "./tax-year-math.ts";

// `taxYearFor` is re-exported so existing call sites keep working unchanged —
// the arithmetic moved to the leaf `tax-year-math.ts` (F-reg-003).
export { taxYearFor };
import type {
  PayrollEmployerLevyContext,
  PayrollEmployerLevyFactors,
  PayrollStatutoryComputeContext,
} from "./statutory-context.ts";
import type { PayrollTaxYearEdition, PayrollTaxYearSupport } from "./tax-years.ts";

// Declared in a leaf module so the packs can import them without closing a
// cycle back through this file; re-exported here for existing call sites.
// See payroll-error.ts for why.
export { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts";
import { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts";

/**
 * Payroll country packs — the jurisdiction layer.
 *
 * A pack declares its statutory liability SLOTS: named account destinations
 * for the withholdings its engine computes, each declaring the seeded
 * components it covers. Slot values live on pay_components.liability_account_id
 * (set for every mapped component at once), so the posting path needs no
 * jurisdiction knowledge at all — it just follows the component's account.
 * Legacy orgs configured before packs existed fall back to the old
 * orgs.settings.payroll keys named here; new configuration always writes
 * the components.
 *
 * The pack's component declarations are also the SEED for those components
 * (engine/src/payroll/run.ts `seedPayrollComponents` provisions exactly this
 * set) and the source of each one's `assessedOn` class, so a jurisdiction's
 * statutory set is declared once, in one place, and nowhere else.
 *
 * The US pack declares its slots (FIT withholding, FICA, FUTA, SUTA) the
 * same way — nothing in the settings UI or the commit path is
 * Canada-specific.
 */

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

/**
 * Which of the generic engine's handed bases a pre-tax deduction reduces.
 * The generic layer sums earning lines into four bases — `income` (taxable
 * periodic earnings), `nonPeriodic` (taxable bonuses and back pay),
 * `pensionable` and `insurable` (the pack's two contributory accumulators) —
 * and a treatment's `reduces` names the legs a line carrying it comes off.
 */
export type PayrollTaxBaseKey = "income" | "nonPeriodic" | "pensionable" | "insurable";

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
 * reduces the income-tax base declares `reduces: ["income"]`. The generic
 * layer subtracts tagged lines from the income leg in full; an engine that
 * taxes bonuses jointly adds the raw `nonPeriodic` leg back (the IE
 * pattern: taxable pay is gross less pension, priced as reduced income plus
 * untouched non-periodic pay). No treatment in the fleet reduces
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

/**
 * What an employer-aggregate levy's base accumulates. The generic layer sums
 * non-accrual earning lines by flag — `gross` is every earning, `taxable` is
 * the taxable subset — reusing the same line flags the per-employee engine
 * already stamps, so a pack cannot invent a base the run cannot see.
 */
export type PayrollAggregateBaseSource = "gross" | "taxable";

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
 *   earnings cap with year-to-date carry).
 *
 * A shelter and a ceiling consume in opposite directions; the assessor
 * implements both and the threshold test pins the difference.
 */
export type PayrollAggregateAllowance =
  | { kind: "none" }
  | { kind: "employer_allowance"; amount: string }
  | { kind: "per_employee_cap"; amount: string };

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
  base: { source: PayrollAggregateBaseSource; scope: PayrollAggregateScope };
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
 * Each pack declares its own LENGTH and CHARACTER SHAPE, and only what its
 * authority states: no pack invents a checksum. A validator that rejects a
 * valid identifier is the defect being fixed, so patterns err toward
 * accepting and the agency rejects.
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
   * with no declared schedule keeps the legacy CRA-function behaviour.
   * OPTIONAL: a pack with no agency of its own to remit to on its own
   * timetable declares none (the US pack's federal deposits ride EFTPS).
   */
   remittanceSchedules?: readonly PayrollRemittanceSchedule[];
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
 * that difference is money. `weekStartsOn` is the statute's own week: 0 is
 * Sunday, which is what the Canada Labour Code fixes (s. 166, midnight Saturday
 * to midnight Saturday) and what Ontario's ESA falls back to when an employer
 * has selected no work week of its own.
 */
export type PayrollHolidayLookbackBoundary =
  | { kind: "day_before" }
  | { kind: "week_before"; weekStartsOn: number };

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
      whenIrregular: PayrollHolidayPayLookbackBasis;
    };

/**
 * The lookback arm of any basis — itself, or a `normal_day`'s fallback.
 *
 * The lookback window is loaded unconditionally, because a `normal_day` rule
 * cannot know until it has resolved the employee's schedule whether it will
 * need it. One accessor, so no caller re-derives the unwrapping and gets it
 * subtly different.
 */
export const holidayPayLookbackBasis = (
  basis: PayrollHolidayPayBasis,
): PayrollHolidayPayLookbackBasis =>
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
 * A jurisdiction inside a country pack: a province, a state, the federal
 * labour code, or a tax administration's own office calendar.
 *
 * `holidayPay: null` is a DECLARATION that the jurisdiction mandates no
 * statutory holiday pay at all (the US, where the FLSA requires no payment for
 * time not worked). It is not the same as a jurisdiction this pack does not
 * declare — that one throws. Silence and "no entitlement" must never be the
 * same value, because one of them is a bug and the other is the law.
 *
 * Anything else is a LIST OF EDITIONS in force over date ranges, resolved
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
}

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

/** Narrow a stored country string to a pack, refusing anything else. */
export function payrollCountry(value: string | null | undefined): PayrollCountry {
  return payrollPack(value ?? "").country;
}

/**
 * Judge one raw identifier value against one country's pack declaration.
 *
 * The value is validated AS GIVEN: outer whitespace is trimmed and Latin
 * letters uppercased (presentation, not identity — `2a` and `2A` are the
 * same Corsican department), then tested whole against the pack's pattern.
 * Nothing is ever stripped first: an input that would become valid only
 * after stripping (a dashed NINO for the US, a de-lettered NIR for France)
 * is refused, not silently transformed.
 *
 * Empty (absent, null, or blank) always clears — or keeps, when the key is
 * omitted — and never refuses: whether the pack REQUIRES one is enforced by
 * the year-end and run-readiness warnings (`packWarnsOnMissingIdentifier`),
 * not by refusing the save, so onboarding is never blocked behind an
 * identifier the operator does not have yet. The refusal message names the
 * pack's own label and shape, so a format 422 is worth showing wherever it
 * surfaces.
 */
export function validatePackEmployeeIdentifier(
  country: string,
  raw: unknown,
): EmployeeIdentifierVerdict {
  const pack = payrollPack(country);
  const declaration = pack.employeeIdentifier;
  const canonical = raw === null || raw === undefined ? "" : String(raw).trim().toUpperCase();
  if (canonical === "") {
    return { valid: true, saved: null, message: null };
  }
  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${declaration.pattern})$`);
  } catch {
    return {
      valid: false,
      saved: null,
      message: `${pack.country} payroll pack declares an invalid identifier pattern`,
    };
  }
  if (!expression.test(canonical)) {
    return {
      valid: false,
      saved: null,
      message: `Invalid ${declaration.label}: expected ${declaration.formatHelp} (e.g. ${declaration.example})`,
    };
  }
  return { valid: true, saved: canonical, message: null };
}

/**
 * Whether the missing-identifier warnings (the year-end agent finding and
 * the run-readiness `employee.noSin`) fire for a country's employees: only
 * when the pack declares the identifier REQUIRED and names a filing that
 * needs it. A pack with no filing to feed, or with a voluntary identifier,
 * warns about nothing — including for a filing the pack otherwise refuses,
 * where the identifier is still needed. Unknown countries warn about
 * nothing: an undeclared pack cannot need an identifier.
 */
export function packWarnsOnMissingIdentifier(country: string): boolean {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) return false;
  const declaration = pack.employeeIdentifier;
  return declaration.requiredForPayroll && declaration.neededFor !== null;
}

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

/**
 * The run's resolved jurisdiction: ONE country, ONE legal entity, ONE
 * currency, ONE tax year, computed at calculate time and passed down instead
 * of being re-derived per employee, per query and per filing artifact.
 */
export interface PayrollRunContext {
  /** The country pack that governs every statutory decision on this run. */
  country: PayrollCountry;
  /** The legal entity that is the employer of record. */
  subsidiaryId: string;
  subsidiaryName: string;
  /** That entity's functional currency; the run document is denominated in it. */
  currency: string;
  /** Per the pack's year definition — never `payDate.slice(0, 4)`. */
  taxYear: number;
  payDate: string;
}

/**
 * Resolve and assert the run half of the chain: subsidiary ⟹ country ⟹
 * currency. Called once per run, before any employee is calculated.
 *
 * The subsidiary is the employer of record, so its country — not the pay
 * schedule's, not the org's, and emphatically not the first employee's — is
 * what decides which statutory engine runs. `subsidiaries.country` has existed
 * all along and no payroll module read it.
 */
export function resolvePayrollRunContext(input: {
  payDate: string;
  subsidiary: {
    id: string;
    name: string;
    country: string | null;
    baseCurrency: string | null;
  };
  /** documents.currency, once the run document exists. */
  runCurrency?: string | null;
}): PayrollRunContext {
  const { subsidiary } = input;
  const entity = subsidiary.name || subsidiary.id;
  let pack: PayrollCountryPack;
  try {
    pack = payrollPack(subsidiary.country ?? "");
  } catch (error) {
    throw new PayrollJurisdictionError(
      `the ${entity} legal entity is registered in `
      + `${subsidiary.country || "no country"} and cannot run payroll: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The pack's engine has no currency argument: T4127 returns CAD and
  // Pub 15-T returns USD. A run denominated in anything else files one
  // currency's numbers on the other's return, and every GL leg balances
  // perfectly while doing it.
  const currency = subsidiary.baseCurrency ?? "";
  if (currency !== pack.statutoryCurrency) {
    throw new PayrollJurisdictionError(
      `${entity} is a payroll entity in ${pack.country}, whose statutory engine computes in `
      + `${pack.statutoryCurrency}, but its functional currency is `
      + `${currency || "unset"} — payroll cannot be run until they agree`,
    );
  }
  if (input.runCurrency != null && input.runCurrency !== currency) {
    throw new PayrollJurisdictionError(
      `this pay run is denominated in ${input.runCurrency} but its ${entity} entity's `
      + `functional currency is ${currency}`,
    );
  }

  return {
    country: pack.country,
    subsidiaryId: subsidiary.id,
    subsidiaryName: subsidiary.name,
    currency,
    taxYear: payrollTaxYear(pack.country, input.payDate),
    payDate: input.payDate,
  };
}

/** One employee's resolved place in the chain, agreed with the run's. */
export interface EmployeePayrollContext {
  employeePartyId: string;
  employeeName: string;
  /** Identical to the run's, by construction — it is asserted, not chosen. */
  country: PayrollCountry;
  /** Province (CA) or state (US) of employment, from the profile snapshot. */
  region: string;
  currency: string;
  taxYear: number;
  /** The filing account this employee's slips and remittances belong to. */
  filingAccountId: string | null;
}

/**
 * Resolve and assert the employee half of the chain, reporting EVERY
 * disagreement at once so the payroll administrator fixes the record in one
 * pass instead of one refusal per attempt.
 *
 * Refusing rather than repairing is the point. Each of these disagreements has
 * two plausible readings — the profile is wrong, or the entity assignment is —
 * and the product cannot know which, so it may not quietly pick one and
 * withhold real money against the guess.
 */
export function resolveEmployeePayrollContext(input: {
  run: PayrollRunContext;
  employee: {
    partyId: string;
    name: string;
    /** employee_payroll_profiles.country — the pack the employee is set to. */
    country: string | null;
    /** employee_payroll_profiles.province — province or state. */
    region: string | null;
    /** parties.subsidiary_id and its country, when the employee is entity-scoped. */
    subsidiaryId?: string | null;
    subsidiaryCountry?: string | null;
    /** The effective payroll_filing_accounts row and the country it files in. */
    filingAccountId?: string | null;
    filingAccountCountry?: string | null;
    filingAccountNumber?: string | null;
  };
}): EmployeePayrollContext {
  const { run, employee } = input;
  const who = employee.name || employee.partyId;
  const problems: string[] = [];

  // Link 1 — the employee's declared pack must be the run entity's pack.
  let country: PayrollCountry | null = null;
  try {
    country = payrollCountry(employee.country);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (country && country !== run.country) {
    problems.push(
      `their payroll profile is on the ${country} country pack, but this run pays from `
      + `${run.subsidiaryName} (${run.country} legal entity) — employees on the ${country} pack `
      + `cannot be paid ${run.country} statutory withholdings`,
    );
  }

  // Link 2 — the employee's OWN legal entity, when they are scoped to one.
  // An org-wide pay schedule pays across subsidiaries, which is exactly how a
  // US-entity employee ended up on a Canadian run with nothing complaining.
  if (employee.subsidiaryCountry && employee.subsidiaryCountry !== run.country) {
    problems.push(
      `their legal entity is in ${employee.subsidiaryCountry} but this run pays from `
      + `${run.subsidiaryName} (${run.country}) — pay them from a pay schedule scoped to `
      + "their own entity",
    );
  }

  // Link 3 — the filing account. Slips and remittances go to the tax
  // authority named by the account, so a CRA program account on a US employee
  // is a false return, not a mislabel.
  if (employee.filingAccountCountry && employee.filingAccountCountry !== run.country) {
    problems.push(
      `their payroll filing account ${employee.filingAccountNumber ?? employee.filingAccountId} `
      + `files in ${employee.filingAccountCountry} — this run files in ${run.country}`,
    );
  }

  // Link 4 — the jurisdiction inside the country must be one the pack can
  // actually withhold for.
  const region = employee.region ?? "";
  try {
    assertPayrollRegionSupported(country ?? run.country, region);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (problems.length > 0) {
    // No employee name here: the caller reports it through its own
    // per-employee channel (PayRunCalculation.errors[].employee, rendered as
    // "name: message"), so prefixing it would print the name twice.
    throw new PayrollJurisdictionError(problems.join("; "));
  }

  return {
    employeePartyId: employee.partyId,
    employeeName: who,
    country: run.country,
    region,
    currency: run.currency,
    taxYear: run.taxYear,
    filingAccountId: employee.filingAccountId ?? null,
  };
}

/**
 * What the pack says this statutory line is assessed on — the engine's only
 * input for deciding whether a protection pass must re-derive it.
 *
 * Undeclared is a hard error, never a default: a new levy that nobody
 * classified must stop the run rather than silently pick a class and either go
 * stale or be double-pushed.
 */
// ---------------------------------------------------------------------------
// Statutory rate declarations, read off the pack registry
// ---------------------------------------------------------------------------
//
// These lived in `statutory-rates.ts` and read this registry from there — the
// edge that closed the F-reg-003 cycle. A function whose whole job is "ask
// every pack" belongs with the registry, so they live here now; the
// calculation half in `statutory-rates.ts` takes the declarations as
// parameters instead.

/**
 * Every pack's rate declaration, read off the pack registry — the same shape
 * as `declaredPayrollFilings()`. The declarations are authored in each pack's
 * own rate module beside the constants they sit next to and carried on
 * `PayrollCountryPack.statutoryRates`; a closed list here would be a second
 * registry a new pack has to edit after declaring itself.
 */
export function declaredPackRates(): PayrollPackRates[] {
  return Object.values(PAYROLL_COUNTRY_PACKS).map((pack) => pack.statutoryRates);
}

/** A pack's rate declaration, or a refusal naming the packs that have one. */
export function packRates(country: string): PayrollPackRates {
  const declared = declaredPackRates().find((entry) => entry.country === country);
  if (!declared) {
    throw new PayrollPackError(
      `the ${country || "(unset)"} payroll pack declares no statutory rate slots — a pack must `
      + "declare which of its statutory rates are tenant-entered and at what scope. Declared for: "
      + (declaredPackRates().map((entry) => entry.country).join(", ") || "none"),
    );
  }
  return declared;
}

/** One slot, or a refusal listing what the pack declares. */
export function statutoryRateSlot(country: string, slotKey: string): PayrollStatutoryRateSlot {
  const pack = packRates(country);
  const slot = pack.slots.find((declared) => declared.key === slotKey);
  if (!slot) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares no "${slotKey}" statutory rate — it declares `
      + (pack.slots.map((declared) => declared.key).join(", ") || "none"),
    );
  }
  return slot;
}

/*
 * No `packsMissingRateDeclarations` probe remains: the declaration is a
 * required `PayrollCountryPack` field read off the pack above, so every
 * installable pack answers by construction and there is no list to fall
 * behind. The third-country pack test asserts the derivation.
 */

export function statutoryAssessment(
  country: string,
  systemKey: string,
  kind: "deduction" | "employer_contribution" | "credit",
): PayrollAssessedOn {
  const declared = packStatutoryComponents(country)
    .filter((component) => component.systemKey === systemKey && component.kind === kind);
  const assessedOn = declared[0]?.assessedOn;
  if (!assessedOn) {
    throw new PayrollPackError(
      `the ${country} payroll pack does not declare what ${systemKey}/${kind} is assessed on — `
      + "add the component to its statutory slot in engine/src/payroll/packs.ts with an "
      + "assessedOn of 'earnings' (gross/pensionable/insurable) or 'taxable_income' "
      + "(income after pre-tax deductions)",
    );
  }
  if (declared.some((component) => component.assessedOn !== assessedOn)) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares conflicting assessedOn values for ${systemKey}/${kind}`,
    );
  }
  return assessedOn;
}

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

// ---------------------------------------------------------------------------
// Destination remittance schedules — the pack declarations due dates compute from
// ---------------------------------------------------------------------------

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

export function statutoryRemittanceDeclaration(country: string): StatutoryRemittanceDeclaration {
  const pack = payrollPack(country);
  const internal = new Set<string>();
  const remitted = new Set<string>();
  const vendorKey = new Map<string, string | null>();
  const regionalVendorKey = new Map<string, Readonly<Record<string, string>>>();
  const legacyKey = new Map<string, string>();
  for (const slot of pack.statutorySlots) {
    for (const component of slot.components) {
      (component.remittance === "internal_accrual" ? internal : remitted)
        .add(component.systemKey);
      if (component.remittance === "tax_authority") {
        // The vendor is the pack's single remittanceVendorSettingsKey, so one
        // pack cannot map one system key to two vendors — the type is the
        // guard, and there is no cross-pack comparison left to make.
        vendorKey.set(component.systemKey, pack.remittanceVendorSettingsKey);
      }
      if (component.regionalRemittanceVendorSettingsKeys) {
        const declared = component.regionalRemittanceVendorSettingsKeys;
        const existing = regionalVendorKey.get(component.systemKey);
        if (existing) {
          for (const [region, key] of Object.entries(declared)) {
            if (region in existing && existing[region] !== key) {
              throw new PayrollPackError(
                `the ${country} payroll pack declares different ${region} remittance vendors for ${component.systemKey}`,
              );
            }
          }
          regionalVendorKey.set(component.systemKey, { ...existing, ...declared });
        } else {
          regionalVendorKey.set(component.systemKey, declared);
        }
      }
      if (slot.legacySettingsKey) {
        const existing = legacyKey.get(component.systemKey);
        if (existing !== undefined && existing !== slot.legacySettingsKey) {
          throw new PayrollPackError(
            `the ${country} payroll pack declares different legacy accounts for ${component.systemKey}`,
          );
        }
        legacyKey.set(component.systemKey, slot.legacySettingsKey);
      }
    }
  }
  for (const systemKey of internal) {
    if (remitted.has(systemKey)) {
      throw new PayrollPackError(
        `the ${country} payroll pack declares ${systemKey} both internal_accrual and remittable`,
      );
    }
  }
  return {
    internalAccrualSystemKeys: [...internal],
    vendorSettingsKeyBySystemKey: vendorKey,
    regionalVendorSettingsKeyBySystemKey: regionalVendorKey,
    legacyLiabilitySettingsKeyBySystemKey: legacyKey,
  };
}

/**
 * Every pack's destination remittance schedules, validated at collection so
 * a bad declaration stops the process that reads it rather than dating a
 * bill from it. A schedule whose `defaultFrequency` names no band, whose
 * band has its floor at or above its ceiling, or whose calendar no pack
 * declares is refused by name — the same fail-fast posture as the component
 * declarations above.
 */
export function allRemittanceSchedules(
  packs: Record<string, PayrollCountryPack> = PAYROLL_COUNTRY_PACKS,
): PayrollRemittanceSchedule[] {
  const schedules = Object.entries(packs).flatMap(([country, pack]) =>
    (pack.remittanceSchedules ?? []).map((schedule) => ({ country, schedule })),
  );
  for (const { country, schedule } of schedules) {
    const where = `the ${country} payroll pack's remittance schedule for ${schedule.vendorSettingsKey || "(no vendor key)"}`;
    if (!schedule.vendorSettingsKey) throw new PayrollPackError(`${where} names no vendor settings key`);
    if (!schedule.authority?.trim()) throw new PayrollPackError(`${where} names no receiving authority`);
    if (schedule.sources.length === 0) throw new PayrollPackError(`${where} cites no published source`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.effectiveFrom)) {
      throw new PayrollPackError(`${where} has no effective-from date`);
    }
    if (schedule.effectiveTo !== undefined
      && (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.effectiveTo) || schedule.effectiveTo <= schedule.effectiveFrom)) {
      throw new PayrollPackError(`${where} has an effective range that ends before it opens`);
    }
    if (!schedule.calendar) throw new PayrollPackError(`${where} names no due-date calendar`);
    if (!payrollJurisdictionDeclared(schedule.calendar)) {
      throw new PayrollPackError(
        `${where} moves deadlines against "${schedule.calendar}", which no payroll pack declares — ` +
        `declare it in engine/src/payroll/packs.ts (declared: ${
          declaredJurisdictions().map((j) => j.key).join(", ")})`,
      );
    }
    if (!schedule.frequencySettingsKey) throw new PayrollPackError(`${where} names no frequency settings key`);
    if (schedule.frequencies.length === 0) throw new PayrollPackError(`${where} declares no frequencies`);
    const names = new Set(schedule.frequencies.map((band) => band.frequency));
    if (names.size !== schedule.frequencies.length) {
      throw new PayrollPackError(`${where} declares a frequency twice`);
    }
    if (!names.has(schedule.defaultFrequency)) {
      throw new PayrollPackError(
        `${where} defaults to "${schedule.defaultFrequency}", which is not one of its declared frequencies`,
      );
    }
    for (const band of schedule.frequencies) {
      switch (band.due.kind) {
        case "month_day":
        case "quarter_day":
        case "split_month":
          break;
        case "quarter_month_working_days":
          if (!Number.isInteger(band.due.workingDays) || band.due.workingDays < 1) {
            throw new PayrollPackError(
              `${where} counts no positive working days for its ${band.frequency} frequency`,
            );
          }
          break;
        default:
          throw new PayrollPackError(
            `${where} declares an unknown due-date rule kind for its ${band.frequency} frequency`,
          );
      }
      if (!band.rule?.trim()) {
        throw new PayrollPackError(`${where} states no due-date rule for its ${band.frequency} frequency`);
      }
      if (band.due.kind === "split_month" && !band.ruleSecondHalf?.trim()) {
        throw new PayrollPackError(
          `${where} states no second-half due-date rule for its ${band.frequency} frequency`,
        );
      }
      if (band.averageMonthlyMin !== undefined && band.averageMonthlyMaxExclusive !== undefined
        && cmp(band.averageMonthlyMin, band.averageMonthlyMaxExclusive) >= 0) {
        throw new PayrollPackError(`${where} has an empty average-monthly band for its ${band.frequency} frequency`);
      }
    }
  }
  for (let i = 0; i < schedules.length; i += 1) {
    for (let j = i + 1; j < schedules.length; j += 1) {
      const a = schedules[i]!;
      const b = schedules[j]!;
      if (a.schedule.vendorSettingsKey !== b.schedule.vendorSettingsKey) continue;
      const aTo = a.schedule.effectiveTo ?? "9999-12-31";
      const bTo = b.schedule.effectiveTo ?? "9999-12-31";
      if (a.schedule.effectiveFrom < bTo && b.schedule.effectiveFrom < aTo) {
        throw new PayrollPackError(
          `two payroll packs declare overlapping remittance schedules for ${a.schedule.vendorSettingsKey}`,
        );
      }
    }
  }
  return schedules.map(({ schedule }) => schedule);
}

/**
 * The schedule version governing one destination on one period-end date, or
 * null when no pack declares the destination — which keeps the legacy
 * CRA-function behaviour for undeclared destinations. Pure over an explicit
 * list, so the effective-dating is verifiable without a database.
 */
export function remittanceScheduleInForce(
  vendorSettingsKey: string,
  date: string,
  schedules: readonly PayrollRemittanceSchedule[] = allRemittanceSchedules(),
): PayrollRemittanceSchedule | null {
  const covering = schedules
    .filter((schedule) => schedule.vendorSettingsKey === vendorSettingsKey
      && schedule.effectiveFrom <= date
      && (schedule.effectiveTo === undefined || date < schedule.effectiveTo));
  covering.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return covering[0] ?? null;
}

/** The declared frequency band, or null when the frequency names nothing. */
export function remittanceFrequencyBand(
  schedule: PayrollRemittanceSchedule,
  frequency: string,
): PayrollRemittanceFrequencyBand | null {
  return schedule.frequencies.find((band) => band.frequency === frequency) ?? null;
}

/**
 * The frequency band an average monthly remittance falls in, or null when no
 * band covers it — which is a declaration gap, never a default. The bands'
 * bounds are decimal strings compared exactly; a value on a shared boundary
 * belongs to the higher band (each ceiling is exclusive, each floor inclusive).
 */
export function remittanceBandForAverage(
  schedule: PayrollRemittanceSchedule,
  averageMonthly: string,
): PayrollRemittanceFrequencyBand | null {
  return schedule.frequencies.find((band) =>
    (band.averageMonthlyMin === undefined || cmp(averageMonthly, band.averageMonthlyMin) >= 0)
    && (band.averageMonthlyMaxExclusive === undefined
      || cmp(averageMonthly, band.averageMonthlyMaxExclusive) < 0),
  ) ?? null;
}

/**
 * ONE pack's destination remittance schedules (see `remittanceSchedules` on
 * the pack). Empty when the pack declares none — the US pack's federal
 * deposits ride EFTPS on no declared timetable.
 */
export function packRemittanceSchedules(country: string): readonly PayrollRemittanceSchedule[] {
  return PAYROLL_COUNTRY_PACKS[country]?.remittanceSchedules ?? [];
}

/**
 * The schedule owning a frequency settings key, or null when no pack
 * declares it. The settings route validates a new schedule's frequency the
 * moment its pack declares both halves.
 */
export function remittanceScheduleForFrequencyKey(
  frequencySettingsKey: string,
): PayrollRemittanceSchedule | null {
  return allRemittanceSchedules()
    .find((schedule) => schedule.frequencySettingsKey === frequencySettingsKey) ?? null;
}

/**
 * Every orgs.settings.payroll key any pack declares as a destination
 * remittance frequency — the same derivation pattern as the vendor keys, so
 * the settings route accepts a new schedule's frequency the moment its pack
 * declares it.
 */
export function declaredRemittanceFrequencySettingsKeys(): string[] {
  return allRemittanceSchedules().map((schedule) => schedule.frequencySettingsKey);
}

/**
 * Every orgs.settings.payroll key any pack declares as a statutory remittance
 * vendor — the pack-level keys plus the regional overrides. The settings API
 * accepts exactly this set, so a new pack's vendor field exists the moment
 * the pack declares it and the route never carries a literal list.
 */
export function declaredRemittanceVendorSettingsKeys(): string[] {
  const keys = new Set<string>();
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const key of packRemittanceVendorSettingsKeys(country)) keys.add(key);
  }
  return [...keys];
}

/**
 * ONE pack's statutory remittance vendor settings keys — the pack-level key
 * plus every regional override its components declare (the CA pack yields the
 * CRA vendor and the Revenu Québec vendor). The payroll setup wizard renders
 * its vendors step from exactly this declaration, so a new pack's vendor
 * fields appear the moment the pack declares them.
 */
export function packRemittanceVendorSettingsKeys(country: string): string[] {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) return [];
  const keys = new Set<string>();
  if (pack.remittanceVendorSettingsKey) keys.add(pack.remittanceVendorSettingsKey);
  for (const slot of pack.statutorySlots) {
    for (const component of slot.components) {
      for (const key of Object.values(component.regionalRemittanceVendorSettingsKeys ?? {})) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * The legacy (pre-pack) liability account for a statutory system key, read
 * from the raw orgs.settings.payroll blob via the SLOT's own declaration.
 *
 * This replaces the literal map the GL projection and the remittance summary
 * each carried (`cpp2` merged into the CPP payable, `qpip` into the EI
 * payable, and no row at all for any third pack). The merges themselves were
 * correct — the CA pack DECLARES them, on the cpp and qpip slots — so behavior
 * is identical; what is gone is the generic layer knowing any of it.
 */
export function legacyStatutoryLiabilityAccount(
  systemKey: string,
  payrollSettingsBlob: Record<string, unknown>,
  country: string | null,
): string | null {
  // Country-first: the slot's declaration for the COMPONENT's pack country. A
  // row naming no country (shared baseline, user components) or a country
  // with no pack carries no pack declaration — the same null as a system key
  // no pack declares, resolved by the caller's undeclared paths.
  if (!country || !PAYROLL_COUNTRY_PACKS[country]) return null;
  const key = statutoryRemittanceDeclaration(country).legacyLiabilitySettingsKeyBySystemKey.get(systemKey);
  if (!key) return null;
  const value = payrollSettingsBlob[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * Seed-time assertion of the contributory-bases declaration. The field is
 * required at compile time; this keeps a pack authored through a cast (tests,
 * scripts) from provisioning components whose pensionable/insurable flags
 * accumulate a base nobody named.
 */
export function assertContributoryBasesDeclared(country: string): void {
  const { contributoryBases } = payrollPack(country);
  if (!contributoryBases?.pensionable?.trim() || !contributoryBases?.insurable?.trim()) {
    throw new PayrollPackError(
      `the ${country} payroll pack does not declare its contributory bases — say what the `
      + "pensionable and insurable earning flags accumulate (engine/src/payroll/packs.ts "
      + "contributoryBases) before its components can be seeded",
    );
  }
}

export interface PackSlotState {
  country: string;
  /**
   * The pack's own display name, served alongside the code so surfaces that
   * list packs to a person never fall back to a bare country code. A
   * surface handed only codes has nothing to show but codes.
   */
  name: string;
  slots: { key: string; accountId: string | null }[];
}

/**
 * A slot with a `regions` declaration applies to a payroll population only
 * where they intersect. Absent population (a caller with no run or roster to
 * scope by) demands everything — today's behaviour — and a null or unknown
 * region still demands: demanding an account mapping is safe, skipping money
 * is not.
 */
export function packSlotAppliesToPopulation(
  slot: PayrollStatutorySlot,
  country: string,
  regionsByCountry?: ReadonlyMap<string, ReadonlySet<string | null>>,
): boolean {
  if (!slot.regions || slot.regions.length === 0) return true;
  const regions = regionsByCountry?.get(country);
  if (!regions || regions.size === 0) return true;
  const known = PAYROLL_COUNTRY_PACKS[country]?.regions?.known;
  for (const region of regions) {
    if (region == null || slot.regions.includes(region)) return true;
    // Fail-safe: a region code the pack does not declare (a typo'd province)
    // is not an inapplicable region — it is an unknown one, and demanding the
    // account mapping is safe while skipping money is not. The run still
    // refuses the undeclared region by name at calculate
    // (assertPayrollRegionSupported), so this demand is the setup half of
    // that refusal, not a second computation.
    if (region != null && known && !known.includes(region)) return true;
  }
  return false;
}

/**
 * Installed packs with each slot's current account: the mapped components'
 * liability account when set, else the legacy settings fallback. Slots that
 * do not apply to the given population are absent, not unmapped — an
 * Ontario-only run never sees the Québec slots at all.
 */
export async function packSlotState(
  orgId: string,
  installedCountries: string[],
  legacySettings: Record<string, unknown>,
  regionsByCountry?: ReadonlyMap<string, ReadonlySet<string | null>>,
): Promise<PackSlotState[]> {
  const packs = installedCountries
    .map((country) => PAYROLL_COUNTRY_PACKS[country])
    .filter((pack): pack is PayrollCountryPack => Boolean(pack));
  if (packs.length === 0) return [];
  const components = (await db.execute<{ country: string | null; code: string; liability_account_id: string | null }>(sql`
    select country, code, liability_account_id from pay_components
     where org_id = ${orgId} and system_key is not null
  `));
  // Keyed by country as well as code: two packs may declare the same code
  // (Canada and Australia both use WCB, 0248), and a code-only map would
  // collapse them to whichever row was read last.
  const byCountryCode = new Map(components.rows.map((c) => [`${c.country ?? ""}:${c.code}`, c.liability_account_id]));
  return packs.map((pack) => ({
    country: pack.country,
    name: pack.name,
    slots: pack.statutorySlots
      .filter((slot) => packSlotAppliesToPopulation(slot, pack.country, regionsByCountry))
      .map((slot) => {
        const fromComponents = slot.components
          .map((component) => byCountryCode.get(`${pack.country}:${component.code}`))
          .find((accountId) => accountId != null);
        const legacy = slot.legacySettingsKey
          ? ((legacySettings[slot.legacySettingsKey] as string | null | undefined) ?? null)
          : null;
        return { key: slot.key, accountId: fromComponents ?? legacy };
      }),
  }));
}

/**
 * Uninstall a country pack: remove its seeded statutory components and the
 * settings marker. Guarded — refuses while anything still depends on the
 * pack, with every blocker named:
 *   - active employee payroll profiles set to the country (their next
 *     calculation would need the pack's engine and components);
 *   - pay stubs whose lines reference the pack's components (payroll
 *     records must keep their component references forever).
 * User-authored components scoped to the country are left alone — they are
 * org configuration, not the pack's.
 */
export async function uninstallPayrollPack(
  orgId: string, actorId: string, country: string,
): Promise<{ componentsRemoved: number }> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) throw new PayrollPackError(`unknown payroll country pack ${country}`);

  const [profiles, stubRefs] = (await Promise.all([
    db.execute<{ n: number }>(sql`
      select count(*)::int as n from employee_payroll_profiles
       where org_id = ${orgId} and country = ${country} and is_active`),
    db.execute<{ n: number }>(sql`
      select count(distinct l.stub_id)::int as n
        from pay_stub_lines l
        join pay_components c on c.id = l.component_id and c.org_id = l.org_id
       where l.org_id = ${orgId} and c.country = ${country} and c.system_key is not null`),
  ]));

  const blockers: string[] = [];
  const profileCount = Number(profiles.rows[0]?.n ?? 0);
  const stubCount = Number(stubRefs.rows[0]?.n ?? 0);
  if (profileCount > 0) {
    blockers.push(`${profileCount} active employee payroll profile(s) are set to ${country} — move or deactivate them first`);
  }
  if (stubCount > 0) {
    blockers.push(`${stubCount} pay stub(s) reference this pack's statutory components — payroll records keep the pack installed`);
  }
  if (blockers.length > 0) {
    throw new PayrollPackError(`cannot uninstall the ${country} pack: ${blockers.join("; ")}`);
  }

  return await db.transaction(async (tx) => {
    // Draft (uncommitted) stubs could still reference the components between
    // the check above and this delete; the FK makes that a loud failure, not
    // a silent orphan.
    const removed = (await tx.execute<{ id: string }>(sql`
      delete from pay_components
       where org_id = ${orgId} and country = ${country} and system_key is not null
       returning id`));
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb), '{payroll,countries}',
           coalesce((
             select jsonb_agg(value) from jsonb_array_elements_text(settings#>'{payroll,countries}')
              where value <> ${country}
           ), '[]'::jsonb))
       where id = ${orgId}`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_components', ${orgId}, 'delete',
              ${JSON.stringify({ uninstalledPayrollPack: country })}, ${actorId})`);
    return { componentsRemoved: removed.rows.length };
  });
}

/** Write one slot's account onto every component the slot covers. */
export async function setPackSlotAccount(
  orgId: string,
  actorId: string,
  country: string,
  slotKey: string,
  accountId: string | null,
): Promise<void> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  const slot = pack?.statutorySlots.find((s) => s.key === slotKey);
  if (!slot) throw new Error(`unknown payroll pack slot ${country}/${slotKey}`);
  if (slot.components.length === 0) return;
  const updated = await db.execute(sql`
    update pay_components
       set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and country = ${country}
       and code = any(${`{${slot.components.map((c) => c.code).join(",")}}`}::text[])
  `);
  // A mapping that touches no component row is a lost save: the setup surface
  // would report success while the slot stays unmapped (the pack's components
  // were never seeded). Refuse rather than report ok.
  if ((updated.rowCount ?? 0) === 0) {
    throw new PayrollPackError(
      `the ${country} "${slotKey}" slot has no seeded payroll components in this organization — `
      + `install the ${country} payroll pack before mapping its accounts`,
    );
  }
}

/**
 * Default a pack's role-declared slots onto the chart account their role
 * resolves to — but only where the operator has not mapped the slot yet.
 *
 * A pack names a ROLE (`liabilityAccountRole`), never an account number, and
 * the org's own chart resolves it, so a withheld-tax slot lands in the
 * payroll-deductions account of whichever chart the org uses (2110 here,
 * 2300 there) without the pack knowing either number. An explicit mapping
 * always wins: this fills `liability_account_id is null` rows only, so it
 * can complete setup but never re-point a configured liability. A role the
 * chart does not map leaves the slot unmapped rather than guessing — commit
 * still refuses an unmapped slot by name. A role mapped to a missing,
 * inactive, or wrong-typed account fails closed here instead of wiring a
 * liability nobody can remit from.
 */
export async function ensurePackSlotRoleAccounts(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  actorId: string | null,
  country: string,
): Promise<void> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) throw new PayrollPackError(`unknown payroll country pack ${country}`);
  const slots = pack.statutorySlots.filter((slot) => slot.liabilityAccountRole);
  if (slots.length === 0) return;
  const settings = (await executor.execute<{ control: unknown }>(sql`
    select settings->'controlAccounts' as control from orgs where id = ${orgId}`));
  const control = (settings.rows[0]?.control ?? {}) as Record<string, unknown>;
  for (const slot of slots) {
    const role = slot.liabilityAccountRole!;
    const accountId = control[role];
    // No role mapping: the operator maps the slot by hand, exactly as a pack
    // without a role declaration. Never invent an account.
    if (accountId == null || accountId === "") continue;
    if (typeof accountId !== "string") {
      throw new PayrollPackError(
        `the ${role} control account is not an account id — map it to the payroll-deductions `
        + "account before installing payroll",
      );
    }
    const records = (await executor.execute<ControlAccountRecord>(sql`
      select id, type, is_active as "isActive", is_summary as "isSummary"
        from accounts
       where org_id = ${orgId} and id = ${accountId}`));
    assertValidControlAccountMappings({ [role]: accountId } as OrgControlAccounts, records.rows);
    await executor.execute(sql`
      update pay_components
         set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId}
         and country = ${country}
         and code = any(${`{${slot.components.map((c) => c.code).join(",")}}`}::text[])
         and liability_account_id is null
    `);
  }
}
