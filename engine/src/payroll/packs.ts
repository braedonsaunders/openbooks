import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import type { PayrollPackFilings } from "../payroll-filing-registry.ts";
import { caPackFilings } from "./canada/filings.ts";
import type { Province } from "./canada/rates.ts";
import { usPackFilings } from "./us/filings.ts";
import { NO_WITHHOLDING_STATES, US_STATES } from "./us/rates.ts";

/**
 * Anything the jurisdiction layer refuses. Declared FIRST because
 * `PayrollJurisdictionError` extends it and a class expression cannot reach
 * forward past its own temporal dead zone.
 */
export class PayrollPackError extends Error {}

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
 * (engine/src/payroll-run.ts `seedPayrollComponents` provisions exactly this
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
 * `calculateStub` needs to know (.local/payroll-pipeline-contract.md).
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
  kind: "deduction" | "employer_contribution";
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
}

/**
 * The countries a payroll pack exists for.
 *
 * Widening this is a PACK, not a cast: `emp.country === "US" ? "US" : "CA"`
 * (what `calculateStub` used to do) turns every unrecognised value — including
 * a country whose pack was never written — into Canada, and Canadian
 * withholding on a foreign employee is silent, unrecoverable, wrong money.
 */
export type PayrollCountry = "CA" | "US";

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

export interface PayrollCountryPack {
  country: PayrollCountry;
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

const CALENDAR_TAX_YEAR: PayrollTaxYearDefinition = {
  basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year",
};

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
  /** Those whose income tax the pack's engine computes end to end. */
  supported: readonly string[];
  /** Why a known-but-unsupported region is refused; `{region}` is substituted. */
  unsupportedReason: string;
  /** Region-specific reason, where the general one would be misleading. */
  unsupportedReasons?: Readonly<Record<string, string>>;
}

/** Every T4127 province code, plus ZZ (employed outside any province). */
const CA_PROVINCES: readonly Province[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT", "ZZ",
];

const CA_REGIONS: PayrollRegionCoverage = {
  label: "province",
  known: CA_PROVINCES,
  // Every province including Quebec: T4127 computes the federal side (with
  // the abatement, QPP, QPIP) and engine/src/payroll/canada/quebec computes
  // TP-1015 provincial income tax; the RL-1 registers onto the CA year-end
  // filings from the same tree.
  supported: CA_PROVINCES,
  unsupportedReason:
    "provincial income tax withholding for {region} is not implemented by the CA payroll pack",
};

const US_REGIONS: PayrollRegionCoverage = {
  label: "state",
  known: US_STATES,
  // Declared in US_STATES order so the coverage list reads the same everywhere.
  supported: US_STATES.filter((code) => NO_WITHHOLDING_STATES.has(code)),
  unsupportedReason:
    "state income tax withholding for {region} is not yet supported — "
    + "the US pack currently covers the nine no-withholding states",
};

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
 */
export type PayrollHolidayPayBasis =
  | {
      kind: "fixed_divisor";
      divisor: number;
      lookbackWeeks: number;
      /** Commission earners get a longer, flatter window in several statutes. */
      commission?: { divisor: number; lookbackWeeks: number; minWeeksEmployed: number };
    }
  | { kind: "average_day"; lookbackDays?: number; lookbackWeeks?: number }
  | { kind: "percent_of_earnings"; percent: string; lookbackWeeks: number };

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
  /** Days with earnings inside a window (BC: 15 of the 30 days before). */
  minDaysWorkedInWindow?: { days: number; ofDays: number };
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
  holidayPay: PayrollHolidayPayRule | null;
}

// --- Reusable holiday rules ------------------------------------------------
// The same day observed by several jurisdictions is declared once; the
// jurisdiction lists say WHICH days it observes, not what a day is.

const NEW_YEARS: PayrollHoliday = {
  key: "new_years", name: "New Year's Day",
  rule: { kind: "fixed", month: 1, day: 1 }, observance: "none",
};
const GOOD_FRIDAY: PayrollHoliday = {
  key: "good_friday", name: "Good Friday",
  rule: { kind: "easter_offset", days: -2 }, observance: "none",
};
const EASTER_MONDAY: PayrollHoliday = {
  key: "easter_monday", name: "Easter Monday",
  rule: { kind: "easter_offset", days: 1 }, observance: "none",
};
const VICTORIA_DAY: PayrollHoliday = {
  key: "victoria_day", name: "Victoria Day",
  // The Monday preceding May 25 — never May 25 itself when that is a Monday.
  rule: { kind: "weekday_before", month: 5, day: 25, weekday: 1 }, observance: "none",
};
const CANADA_DAY: PayrollHoliday = {
  key: "canada_day", name: "Canada Day",
  rule: { kind: "fixed", month: 7, day: 1 }, observance: "none",
};
const LABOUR_DAY: PayrollHoliday = {
  key: "labour_day", name: "Labour Day",
  rule: { kind: "nth_weekday", month: 9, weekday: 1, nth: 1 }, observance: "none",
};
const TRUTH_AND_RECONCILIATION: PayrollHoliday = {
  key: "truth_and_reconciliation", name: "National Day for Truth and Reconciliation",
  rule: { kind: "fixed", month: 9, day: 30 }, observance: "none", from: 2021,
};
const THANKSGIVING_CA: PayrollHoliday = {
  key: "thanksgiving", name: "Thanksgiving Day",
  rule: { kind: "nth_weekday", month: 10, weekday: 1, nth: 2 }, observance: "none",
};
const REMEMBRANCE_DAY: PayrollHoliday = {
  key: "remembrance_day", name: "Remembrance Day",
  rule: { kind: "fixed", month: 11, day: 11 }, observance: "none",
};
const CHRISTMAS: PayrollHoliday = {
  key: "christmas", name: "Christmas Day",
  rule: { kind: "fixed", month: 12, day: 25 }, observance: "none",
};
const BOXING_DAY: PayrollHoliday = {
  key: "boxing_day", name: "Boxing Day",
  rule: { kind: "fixed", month: 12, day: 26 }, observance: "none",
};
const THIRD_MONDAY_FEBRUARY: PayrollHolidayRule = {
  kind: "nth_weekday", month: 2, weekday: 1, nth: 3,
};
const FIRST_MONDAY_AUGUST: PayrollHolidayRule = {
  kind: "nth_weekday", month: 8, weekday: 1, nth: 1,
};

/** The Canada Labour Code moves a weekend general holiday to a working day. */
const federal = (holiday: PayrollHoliday): PayrollHoliday => ({
  ...holiday, observance: "next_monday",
});

// --- Canadian holiday-pay rules --------------------------------------------

/**
 * Canada Labour Code s. 196(1)–(2). One twentieth of the wages, excluding
 * overtime pay, earned in the four-week period immediately preceding the week
 * in which the holiday occurs; one sixtieth over twelve weeks for a commission
 * earner with at least twelve weeks of continuous employment. The thirty-day
 * qualifying period was repealed effective 2019-09-01, so there is none.
 */
const CLC_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Canada Labour Code, RSC 1985 c L-2, ss. 196–197",
  basis: {
    kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4,
    commission: { divisor: 60, lookbackWeeks: 12, minWeeksEmployed: 12 },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: false },
  premium: { multiplier: "1.5", plusHolidayPay: true },
};

/**
 * Ontario ESA s. 24(1)(a). All of the REGULAR wages earned in the four work
 * weeks before the work week with the public holiday, plus all of the vacation
 * pay payable with respect to those four work weeks, divided by 20. Regular
 * wages exclude overtime pay, premium pay, and pay for other public holidays —
 * which is why `holidayPay` is false here and true federally.
 */
const ON_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act, 2000 (Ontario), ss. 24(1)(a), 26, 29",
  basis: { kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4 },
  include: { overtime: false, vacationPay: true, holidayPay: false },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
};

/**
 * Quebec LSA s. 62. One twentieth of the wages earned during the four complete
 * weeks of pay preceding the week of the holiday, excluding overtime; one
 * sixtieth over twelve complete weeks for an employee remunerated in whole or
 * in part on commission. No service requirement since 2003-05-01 (s. 65).
 */
const QC_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Act respecting labour standards (Quebec), CQLR c N-1.1, ss. 62–65",
  basis: {
    kind: "fixed_divisor", divisor: 20, lookbackWeeks: 4,
    commission: { divisor: 60, lookbackWeeks: 12, minWeeksEmployed: 12 },
  },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1", plusHolidayPay: true },
};

/**
 * British Columbia ESA ss. 44–46. An average day's pay: the amount paid or
 * payable for work done and wages earned in the 30 calendar days preceding the
 * holiday — vacation pay for vacation days taken in the period included,
 * overtime excluded — divided by the number of days worked or on which wages
 * were earned. Qualifying: employed 30 calendar days AND worked or earned
 * wages on at least 15 of them. Premium: time and a half to 12 hours, double
 * beyond, plus the average day's pay.
 */
const BC_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Act (British Columbia), RSBC 1996 c 113, ss. 44–46",
  basis: { kind: "average_day", lookbackDays: 30 },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: {
    minEmploymentDays: 30,
    minDaysWorkedInWindow: { days: 15, ofDays: 30 },
    lastAndFirstScheduledShift: false,
  },
  premium: {
    multiplier: "1.5", overtimeAfterHours: 12, overtimeMultiplier: "2",
    plusHolidayPay: true,
  },
};

/**
 * Alberta Employment Standards Code. Average daily wage = wages divided by the
 * number of days worked, over the four weeks immediately preceding the holiday
 * (an employer may instead use the four weeks ending on the last day of the
 * preceding pay period; this declares the statutory default). Overtime pay is
 * not wages for this purpose. An employee absent without the employer's
 * consent on the last scheduled workday before or the first after loses the
 * day.
 */
const AB_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "Employment Standards Code (Alberta), RSA 2000 c E-9, Part 2 Div. 5",
  basis: { kind: "average_day", lookbackWeeks: 4 },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: true },
  premium: { multiplier: "1.5", plusHolidayPay: true },
};

/**
 * Saskatchewan Employment Act s. 2-33. Five per cent of the employee's wages,
 * not including overtime, in the four weeks preceding the public holiday. An
 * employee who has worked less than four weeks is still entitled to 5% of what
 * they have earned, so there is no service qualifier.
 */
const SK_HOLIDAY_PAY: PayrollHolidayPayRule = {
  citation: "The Saskatchewan Employment Act, SS 2013 c S-15.1, s. 2-33",
  basis: { kind: "percent_of_earnings", percent: "5", lookbackWeeks: 4 },
  include: { overtime: false, vacationPay: true, holidayPay: true },
  qualifying: { lastAndFirstScheduledShift: false },
  premium: { multiplier: "1.5", plusHolidayPay: true },
};

// --- Canadian jurisdictions ------------------------------------------------

const CA_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "CA",
    name: "Canada (federally regulated)",
    scope: "employment",
    citation: "Canada Labour Code, RSC 1985 c L-2, ss. 191–197",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY,
      TRUTH_AND_RECONCILIATION, THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      BOXING_DAY,
    ].map(federal),
    holidayPay: CLC_HOLIDAY_PAY,
  },
  {
    key: "CA-ON",
    name: "Ontario",
    scope: "employment",
    citation: "Employment Standards Act, 2000 (Ontario), s. 1 'public holiday'",
    holidays: [
      NEW_YEARS,
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY, THANKSGIVING_CA,
      CHRISTMAS, BOXING_DAY,
      // Not ESA public holidays. An Ontario employer may observe them, and
      // many do, but only by election — hence optional, not absent.
      { key: "civic_holiday", name: "Civic Holiday", rule: FIRST_MONDAY_AUGUST, observance: "none", optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
      { ...REMEMBRANCE_DAY, optional: true },
      { ...EASTER_MONDAY, optional: true },
    ],
    holidayPay: ON_HOLIDAY_PAY,
  },
  {
    key: "CA-QC",
    name: "Quebec",
    scope: "employment",
    citation: "Act respecting labour standards (Quebec), s. 60; National Holiday Act, CQLR c F-1.1",
    holidays: [
      NEW_YEARS,
      // s. 60(2): Good Friday OR Easter Monday, at the employer's option. The
      // statutory default declared here is Good Friday; an employer that
      // chooses Easter Monday turns the optional day on and this one off.
      GOOD_FRIDAY,
      { ...EASTER_MONDAY, optional: true },
      { key: "national_patriots_day", name: "National Patriots' Day",
        rule: { kind: "weekday_before", month: 5, day: 25, weekday: 1 }, observance: "none" },
      { key: "st_jean_baptiste", name: "National Holiday (Saint-Jean-Baptiste)",
        rule: { kind: "fixed", month: 6, day: 24 }, observance: "none" },
      CANADA_DAY, LABOUR_DAY, THANKSGIVING_CA, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
      { ...REMEMBRANCE_DAY, optional: true },
    ],
    holidayPay: QC_HOLIDAY_PAY,
  },
  {
    key: "CA-BC",
    name: "British Columbia",
    scope: "employment",
    citation: "Employment Standards Act (British Columbia), s. 1 'statutory holiday'",
    holidays: [
      NEW_YEARS,
      // Moved from the second to the THIRD Monday in February in 2019.
      { key: "family_day", name: "Family Day",
        rule: { kind: "nth_weekday", month: 2, weekday: 1, nth: 2 }, observance: "none", until: 2018 },
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none", from: 2019 },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY,
      { key: "bc_day", name: "British Columbia Day", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY,
      // A BC statutory holiday from 2023 (Bill 2, 2023).
      { ...TRUTH_AND_RECONCILIATION, from: 2023 },
      THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
    ],
    holidayPay: BC_HOLIDAY_PAY,
  },
  {
    key: "CA-AB",
    name: "Alberta",
    scope: "employment",
    citation: "Employment Standards Code (Alberta), s. 1(1)(n) 'general holiday'",
    holidays: [
      NEW_YEARS,
      { key: "family_day", name: "Alberta Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY, LABOUR_DAY, THANKSGIVING_CA,
      REMEMBRANCE_DAY, CHRISTMAS,
      // Alberta's optional general holidays, listed by the Code itself.
      { ...EASTER_MONDAY, optional: true },
      { key: "heritage_day", name: "Heritage Day", rule: FIRST_MONDAY_AUGUST, observance: "none", optional: true },
      { ...BOXING_DAY, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
    ],
    holidayPay: AB_HOLIDAY_PAY,
  },
  {
    key: "CA-SK",
    name: "Saskatchewan",
    scope: "employment",
    citation: "The Saskatchewan Employment Act, s. 2-1(1)(o) 'public holiday'",
    holidays: [
      NEW_YEARS,
      { key: "family_day", name: "Family Day", rule: THIRD_MONDAY_FEBRUARY, observance: "none" },
      GOOD_FRIDAY, VICTORIA_DAY, CANADA_DAY,
      { key: "saskatchewan_day", name: "Saskatchewan Day", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY, THANKSGIVING_CA, REMEMBRANCE_DAY, CHRISTMAS,
      { ...BOXING_DAY, optional: true },
      { ...TRUTH_AND_RECONCILIATION, optional: true },
    ],
    holidayPay: SK_HOLIDAY_PAY,
  },
  {
    /**
     * The CRA's OWN office calendar, which is not any employment-standards
     * calendar: it carries Easter Monday and the Civic Holiday, which no
     * province's ESA lists, and it is the calendar a remittance due date moves
     * against ("a public holiday recognized by the CRA"). Declaring it as a
     * jurisdiction keeps the tax administration's calendar from being confused
     * with an employer's — they genuinely differ, and using one for the other
     * is how a remittance lands a day late.
     *
     * It pays nobody: `holidayPay: null` says the CRA calendar mandates no
     * employee entitlement, which is true — it is a due-date calendar.
     */
    key: "CA-CRA",
    name: "Canada Revenue Agency (remittance due dates)",
    scope: "tax_administration",
    citation: "https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, EASTER_MONDAY, VICTORIA_DAY, CANADA_DAY,
      { key: "civic_holiday", name: "Civic Holiday", rule: FIRST_MONDAY_AUGUST, observance: "none" },
      LABOUR_DAY, TRUTH_AND_RECONCILIATION, THANKSGIVING_CA, REMEMBRANCE_DAY,
      CHRISTMAS, BOXING_DAY,
    ],
    holidayPay: null,
  },
  {
    /** The CRA calendar as it applies in Quebec: Saint-Jean-Baptiste Day is
     *  recognized there and the Civic Holiday is not. */
    key: "CA-CRA-QC",
    name: "Canada Revenue Agency — Quebec (remittance due dates)",
    scope: "tax_administration",
    citation: "https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html",
    holidays: [
      NEW_YEARS, GOOD_FRIDAY, EASTER_MONDAY, VICTORIA_DAY,
      { key: "st_jean_baptiste", name: "Saint-Jean-Baptiste Day",
        rule: { kind: "fixed", month: 6, day: 24 }, observance: "none" },
      CANADA_DAY, LABOUR_DAY, TRUTH_AND_RECONCILIATION, THANKSGIVING_CA,
      REMEMBRANCE_DAY, CHRISTMAS, BOXING_DAY,
    ],
    holidayPay: null,
  },
] as const;

// --- United States ---------------------------------------------------------

/**
 * The federal holidays of 5 U.S.C. 6103, observed on the nearest weekday under
 * 6103(b). They are days off for federal employees; the FLSA requires no
 * private employer to pay for time not worked, on a holiday or otherwise, so
 * `holidayPay` is a declared null rather than an unimplemented formula. A
 * state that DOES mandate holiday pay (Rhode Island and Massachusetts have
 * premium-pay statutes) is deliberately absent, so an employer there is
 * refused rather than paid a made-up number.
 */
const US_FEDERAL_HOLIDAYS: readonly PayrollHoliday[] = [
      { key: "new_years", name: "New Year's Day", rule: { kind: "fixed", month: 1, day: 1 }, observance: "nearest_weekday" },
      { key: "mlk_day", name: "Birthday of Martin Luther King, Jr.", rule: { kind: "nth_weekday", month: 1, weekday: 1, nth: 3 }, observance: "nearest_weekday" },
      { key: "washingtons_birthday", name: "Washington's Birthday", rule: { kind: "nth_weekday", month: 2, weekday: 1, nth: 3 }, observance: "nearest_weekday" },
      { key: "memorial_day", name: "Memorial Day", rule: { kind: "nth_weekday", month: 5, weekday: 1, nth: -1 }, observance: "nearest_weekday" },
      { key: "juneteenth", name: "Juneteenth National Independence Day", rule: { kind: "fixed", month: 6, day: 19 }, observance: "nearest_weekday", from: 2021 },
      { key: "independence_day", name: "Independence Day", rule: { kind: "fixed", month: 7, day: 4 }, observance: "nearest_weekday" },
      { key: "labor_day", name: "Labor Day", rule: { kind: "nth_weekday", month: 9, weekday: 1, nth: 1 }, observance: "nearest_weekday" },
      { key: "columbus_day", name: "Columbus Day", rule: { kind: "nth_weekday", month: 10, weekday: 1, nth: 2 }, observance: "nearest_weekday" },
      { key: "veterans_day", name: "Veterans Day", rule: { kind: "fixed", month: 11, day: 11 }, observance: "nearest_weekday" },
      { key: "thanksgiving", name: "Thanksgiving Day", rule: { kind: "nth_weekday", month: 11, weekday: 4, nth: 4 }, observance: "nearest_weekday" },
      { key: "christmas", name: "Christmas Day", rule: { kind: "fixed", month: 12, day: 25 }, observance: "nearest_weekday" },
] as const;

/**
 * States whose own statute imposes a holiday premium-pay obligation on private
 * employers. Massachusetts (the Blue Laws, M.G.L. c. 136 §§ 6, 13) and Rhode
 * Island (R.I. Gen. Laws § 25-3) both do, and neither is transcribed here.
 * They are therefore OMITTED from the declared jurisdictions entirely, so an
 * employer in one is refused by name instead of inheriting the federal
 * "no mandate" answer and being paid nothing. Adding either means transcribing
 * its rule, not deleting it from this list.
 */
const US_STATES_WITH_HOLIDAY_PAY_MANDATE: ReadonlySet<string> = new Set(["MA", "RI"]);

const US_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "US",
    name: "United States (federal)",
    scope: "employment",
    citation: "5 U.S.C. 6103; FLSA 29 U.S.C. 201 et seq. (no holiday-pay mandate)",
    holidays: US_FEDERAL_HOLIDAYS,
    holidayPay: null,
  },
  // Every state that imposes no holiday-pay obligation of its own observes the
  // federal calendar and mandates nothing — declared explicitly, one per
  // state, so that "this state was never considered" and "this state requires
  // nothing" cannot be the same answer.
  ...US_STATES.filter((state) => !US_STATES_WITH_HOLIDAY_PAY_MANDATE.has(state))
    .map((state): PayrollJurisdiction => ({
      key: `US-${state}`,
      name: `United States — ${state}`,
      scope: "employment",
      citation: "5 U.S.C. 6103; FLSA 29 U.S.C. 201 et seq. (no state holiday-pay mandate)",
      holidays: US_FEDERAL_HOLIDAYS,
      holidayPay: null,
    })),
];

export const PAYROLL_COUNTRY_PACKS: Record<string, PayrollCountryPack> = {
  CA: {
    country: "CA",
    installable: true,
    // T4127 produces CAD; the CRA's tax year is the calendar year.
    statutoryCurrency: "CAD",
    taxYear: CALENDAR_TAX_YEAR,
    regions: CA_REGIONS,
    jurisdictions: CA_JURISDICTIONS,
    // Source deductions are remitted to the Receiver General through the
    // org-configured CRA remittance vendor.
    remittanceVendorSettingsKey: "craRemittancePartyId",
    contributoryBases: {
      pensionable: "CPP/QPP pensionable earnings (T4127 factor PI)",
      insurable: "EI insurable earnings (T4127 factor IE)",
    },
    // T4127 factor U1: employee-paid dues reduce taxable income.
    employeeUnionDuesTaxTreatment: "union_dues",
    filings: caPackFilings,
    statutorySlots: [
      {
        key: "income_tax",
        legacySettingsKey: "taxPayableAccountId",
        components: [
          // T4127 factor T: annual taxable income A is income LESS the
          // factor-F / F2 / U1 deductions, so a pre-tax protected order moves
          // it. The only Canadian line the fixpoint re-derives.
          { code: "TAX", name: "Income tax", systemKey: "income_tax", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
        ],
      },
      {
        key: "qc_income_tax",
        components: [
          // TP-1015 variable A: annual taxable income I is income LESS the
          // factor-F / H / CSA deductions, so a pre-tax protected order moves
          // it — re-derived by the fixpoint exactly like federal income_tax.
          //
          // remittance is "external", NOT "tax_authority": Québec source
          // deductions are remitted to Revenu Québec (form TPZ-1015.R), a
          // different agency from the CRA vendor the pack's
          // remittanceVendorSettingsKey names. The org configures its Revenu
          // Québec vendor on this component's remittance_party_id — that
          // difference in destination is the entire reason this is a second
          // slot and not part of income_tax.
          { code: "QCTAX", name: "Québec income tax", systemKey: "qc_income_tax", kind: "deduction", sequence: 115, assessedOn: "taxable_income", remittance: "external" },
        ],
      },
      {
        key: "cpp",
        legacySettingsKey: "cppPayableAccountId",
        components: [
          // C and C2 are rate × (pensionable income − exemption), capped on
          // YTD contributions. No deduction enters the formula.
          //
          // For a QC employee the same slot IS the QPP: T4127 computes QPP
          // under the C/C2 factors and the run pushes the same system keys.
          // QPP is remitted to Revenu Québec on TPZ-1015.R, not to the CRA —
          // the regional declaration routes the QC share there.
          { code: "CPP", name: "CPP", systemKey: "cpp", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
          { code: "CPP2", name: "CPP (second additional)", systemKey: "cpp2", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
          { code: "CPP-ER", name: "CPP (employer)", systemKey: "cpp", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
        ],
      },
      {
        key: "ei",
        legacySettingsKey: "eiPayableAccountId",
        components: [
          // EI is rate × insurable earnings; the employer share is a multiple
          // of the employee's. EI is FEDERAL for every province including
          // Quebec — no regional override; it always goes to the CRA vendor.
          { code: "EI", name: "EI", systemKey: "ei", kind: "deduction", sequence: 140, assessedOn: "earnings", remittance: "tax_authority" },
          { code: "EI-ER", name: "EI (employer)", systemKey: "ei", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "tax_authority" },
        ],
      },
      {
        key: "qpip",
        legacySettingsKey: "eiPayableAccountId",
        components: [
          // QPIP exists only for QC employment, and it is remitted to Revenu
          // Québec on TPZ-1015.R — declared per region for the same reason as
          // QPP, so the declaration stays on the component, not in the
          // remittance module.
          { code: "QPIP", name: "QPIP", systemKey: "qpip", kind: "deduction", sequence: 150, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
          { code: "QPIP-ER", name: "QPIP (employer)", systemKey: "qpip", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority", regionalRemittanceVendorSettingsKeys: { QC: "rqRemittancePartyId" } },
        ],
      },
      {
        key: "vacation",
        legacySettingsKey: "vacationPayableAccountId",
        components: [
          // A percentage of vacationable EARNINGS (the entitlement engine
          // emits it, phase 7), never of anything net of a deduction.
          { code: "VAC", name: "Vacation accrual", systemKey: "vacation_accrual", kind: "employer_contribution", sequence: 240, assessedOn: "earnings", remittance: "internal_accrual" },
        ],
      },
      {
        key: "wcb",
        components: [
          // Assessable earnings × the worker-comp group's rate, job-split
          // proportional to the earnings it assesses.
          { code: "WCB", name: "Workers' compensation (WCB/WSIB)", systemKey: "wcb", kind: "employer_contribution", sequence: 260, assessedOn: "earnings", remittance: "external" },
        ],
      },
      {
        key: "eht",
        components: [
          // Ontario remuneration past the annual exemption — remuneration is
          // an earnings measure.
          { code: "EHT", name: "Employer Health Tax", systemKey: "eht", kind: "employer_contribution", sequence: 270, assessedOn: "earnings", remittance: "external" },
        ],
      },
    ],
  },
  US: {
    country: "US",
    installable: true,
    // Pub 15-T produces USD; the IRS tax year is the calendar year.
    statutoryCurrency: "USD",
    taxYear: CALENDAR_TAX_YEAR,
    regions: US_REGIONS,
    jurisdictions: US_JURISDICTIONS,
    // Federal deposits ride EFTPS; no single remittance vendor is configured,
    // so US statutory withholdings surface unassigned until one is.
    remittanceVendorSettingsKey: null,
    contributoryBases: {
      pensionable: "FICA (Social Security and Medicare) wages",
      insurable: "FUTA and state unemployment (SUI) wages",
    },
    // Post-tax under the IRC: union dues stopped being deductible for
    // employees with the TCJA (2018). No treatment.
    employeeUnionDuesTaxTreatment: null,
    filings: usPackFilings,
    statutorySlots: [
      {
        key: "fit",
        components: [
          // Pub 15-T works from annualized taxable wages, so a pre-tax
          // deduction (§125, 401(k)) moves it exactly as factor F moves T.
          { code: "FIT", name: "Federal income tax", systemKey: "fit", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
        ],
      },
      {
        key: "fica",
        components: [
          // Rate × FICA wages against the wage base — deductions do not enter.
          { code: "SS", name: "Social Security", systemKey: "ss", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "tax_authority" },
          { code: "MED", name: "Medicare", systemKey: "medicare", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "tax_authority" },
          { code: "MED2", name: "Additional Medicare", systemKey: "medicare_addl", kind: "deduction", sequence: 135, assessedOn: "earnings", remittance: "tax_authority" },
          { code: "SS-ER", name: "Social Security (employer)", systemKey: "ss", kind: "employer_contribution", sequence: 210, assessedOn: "earnings", remittance: "tax_authority" },
          { code: "MED-ER", name: "Medicare (employer)", systemKey: "medicare", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "tax_authority" },
        ],
      },
      {
        key: "futa",
        components: [
          { code: "FUTA", name: "Federal unemployment (FUTA)", systemKey: "futa", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "tax_authority" },
        ],
      },
      {
        key: "suta",
        components: [
          { code: "SUTA", name: "State unemployment (SUI)", systemKey: "suta", kind: "employer_contribution", sequence: 250, assessedOn: "earnings", remittance: "external" },
        ],
      },
    ],
  },
};

/** Every statutory component a pack provisions, in slot order. */
export function packStatutoryComponents(country: string): readonly PayrollStatutoryComponent[] {
  return payrollPack(country).statutorySlots.flatMap((slot) => slot.components);
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
export class PayrollJurisdictionError extends PayrollPackError {}

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
 * The arithmetic behind `payrollTaxYear`, separated so the MECHANISM is
 * testable against jurisdictions no pack has yet — an HMRC 6-April year and an
 * ATO 1-July year — rather than only against the two packs that both answer
 * "calendar" and would pass even if the whole thing were still hardcoded.
 */
export function taxYearFor(definition: PayrollTaxYearDefinition, payDate: string): number {
  const [year, month, day] = payDate.split("-").map(Number);
  if (!year || !month || !day) {
    throw new PayrollJurisdictionError(`invalid pay date "${payDate}"`);
  }
  const opensThisYear = month > definition.startMonth
    || (month === definition.startMonth && day >= definition.startDay);
  const openingYear = opensThisYear ? year : year - 1;
  return definition.namedBy === "opening_year" ? openingYear : openingYear + 1;
}

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
      `${entity} is a ${pack.country} payroll entity, whose statutory engine computes in `
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
      + `${run.subsidiaryName}, a ${run.country} legal entity — a ${country} employee cannot be `
      + `paid ${run.country} statutory withholdings`,
    );
  }

  // Link 2 — the employee's OWN legal entity, when they are scoped to one.
  // An org-wide pay schedule pays across subsidiaries, which is exactly how a
  // US-entity employee ended up on a Canadian run with nothing complaining.
  if (employee.subsidiaryCountry && employee.subsidiaryCountry !== run.country) {
    problems.push(
      `they belong to a ${employee.subsidiaryCountry} legal entity but this run pays from `
      + `${run.subsidiaryName} (${run.country}) — pay them from a ${employee.subsidiaryCountry} `
      + "pay schedule scoped to their own entity",
    );
  }

  // Link 3 — the filing account. Slips and remittances go to the tax
  // authority named by the account, so a CRA program account on a US employee
  // is a false return, not a mislabel.
  if (employee.filingAccountCountry && employee.filingAccountCountry !== run.country) {
    problems.push(
      `their payroll filing account ${employee.filingAccountNumber ?? employee.filingAccountId} `
      + `is a ${employee.filingAccountCountry} account, which cannot file a ${run.country} return`,
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
    throw new PayrollJurisdictionError(`${who}: ${problems.join("; ")}`);
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
export function statutoryAssessment(
  country: string,
  systemKey: string,
  kind: "deduction" | "employer_contribution",
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
 */
export function jurisdictionKey(country: string, province: string | null): string {
  const region = (province ?? "").trim().toUpperCase();
  if (!region) return country;
  return `${country}-${region}`;
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
// Statutory remittance and posting — the pack declarations, resolved once
// ---------------------------------------------------------------------------

/**
 * Every pack's remittance and legacy-account declarations folded into three
 * lookups by system key. Cross-pack, because the remittance summary and the GL
 * projection both see stub lines from every installed pack at once; a system
 * key two packs declare DIFFERENTLY is a refusal, never a coin toss.
 */
export interface StatutoryRemittanceDeclaration {
  /** System keys declared `internal_accrual` — never remitted, by anyone. */
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

export function statutoryRemittanceDeclaration(): StatutoryRemittanceDeclaration {
  const internal = new Set<string>();
  const remitted = new Set<string>();
  const vendorKey = new Map<string, string | null>();
  const regionalVendorKey = new Map<string, Readonly<Record<string, string>>>();
  const legacyKey = new Map<string, string>();
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    for (const slot of pack.statutorySlots) {
      for (const component of slot.components) {
        (component.remittance === "internal_accrual" ? internal : remitted)
          .add(component.systemKey);
        if (component.remittance === "tax_authority") {
          const declared = pack.remittanceVendorSettingsKey;
          const existing = vendorKey.get(component.systemKey);
          if (existing !== undefined && existing !== declared) {
            throw new PayrollPackError(
              `two payroll packs declare different remittance vendors for ${component.systemKey}`,
            );
          }
          vendorKey.set(component.systemKey, declared);
        }
        if (component.regionalRemittanceVendorSettingsKeys) {
          const declared = component.regionalRemittanceVendorSettingsKeys;
          const existing = regionalVendorKey.get(component.systemKey);
          if (existing) {
            for (const [region, key] of Object.entries(declared)) {
              if (region in existing && existing[region] !== key) {
                throw new PayrollPackError(
                  `two payroll pack components declare different ${region} remittance vendors for ${component.systemKey}`,
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
              `two payroll pack slots declare different legacy accounts for ${component.systemKey}`,
            );
          }
          legacyKey.set(component.systemKey, slot.legacySettingsKey);
        }
      }
    }
  }
  for (const systemKey of internal) {
    if (remitted.has(systemKey)) {
      throw new PayrollPackError(
        `payroll packs declare ${systemKey} both internal_accrual and remittable`,
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
 * Every orgs.settings.payroll key any pack declares as a statutory remittance
 * vendor — the pack-level keys plus the regional overrides. The settings API
 * accepts exactly this set, so a new pack's vendor field exists the moment
 * the pack declares it and the route never carries a literal list.
 */
export function declaredRemittanceVendorSettingsKeys(): string[] {
  const keys = new Set<string>();
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    if (pack.remittanceVendorSettingsKey) keys.add(pack.remittanceVendorSettingsKey);
    for (const slot of pack.statutorySlots) {
      for (const component of slot.components) {
        for (const key of Object.values(component.regionalRemittanceVendorSettingsKeys ?? {})) {
          keys.add(key);
        }
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
): string | null {
  const key = statutoryRemittanceDeclaration().legacyLiabilitySettingsKeyBySystemKey.get(systemKey);
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
  slots: { key: string; accountId: string | null }[];
}

/**
 * Installed packs with each slot's current account: the mapped components'
 * liability account when set, else the legacy settings fallback.
 */
export async function packSlotState(
  orgId: string,
  installedCountries: string[],
  legacySettings: Record<string, unknown>,
): Promise<PackSlotState[]> {
  const packs = installedCountries
    .map((country) => PAYROLL_COUNTRY_PACKS[country])
    .filter((pack): pack is PayrollCountryPack => Boolean(pack));
  if (packs.length === 0) return [];
  const components = (await db.execute(sql`
    select code, liability_account_id from pay_components
     where org_id = ${orgId} and system_key is not null
  `)) as unknown as { rows: { code: string; liability_account_id: string | null }[] };
  const byCode = new Map(components.rows.map((c) => [c.code, c.liability_account_id]));
  return packs.map((pack) => ({
    country: pack.country,
    slots: pack.statutorySlots.map((slot) => {
      const fromComponents = slot.components
        .map((component) => byCode.get(component.code))
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
    db.execute(sql`
      select count(*)::int as n from employee_payroll_profiles
       where org_id = ${orgId} and country = ${country} and is_active`),
    db.execute(sql`
      select count(distinct l.stub_id)::int as n
        from pay_stub_lines l
        join pay_components c on c.id = l.component_id
       where l.org_id = ${orgId} and c.country = ${country} and c.system_key is not null`),
  ])) as unknown as { rows: { n: number }[] }[];

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
    const removed = (await tx.execute(sql`
      delete from pay_components
       where org_id = ${orgId} and country = ${country} and system_key is not null
       returning id`)) as unknown as { rows: { id: string }[] };
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
  await db.execute(sql`
    update pay_components
       set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and code = any(${`{${slot.components.map((c) => c.code).join(",")}}`}::text[])
  `);
}
