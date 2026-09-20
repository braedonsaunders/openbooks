import type {
  PayrollCountryPack,
  PayrollHoliday,
  PayrollJurisdiction,
  PayrollRegionCoverage,
} from "../packs.ts";
import { computeUsStatutory, US_COMPUTE_FACTOR_LABELS } from "./compute-statutory.ts";
import { usPackFilings } from "./filings.ts";
import { US_CERTIFICATES, US_RECIPROCITY, US_WITHHOLDING } from "./jurisdictions.ts";
import { US_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import { PUB15T_FACTOR_LABELS } from "./pub15t.ts";
import { US_PACK_RATES, US_STATES, US_TAX_YEARS } from "./rates.ts";
import { implementedUsStates, supportedUsStates, usStateWithholding } from "./states/index.ts";
import { AL_FACTOR_LABELS } from "./states/al.ts";
import { AR_FACTOR_LABELS } from "./states/ar.ts";
import { AZ_FACTOR_LABELS } from "./states/az.ts";
import { CA_FACTOR_LABELS } from "./states/ca.ts";
import { CO_FACTOR_LABELS } from "./states/co.ts";
import { CT_FACTOR_LABELS } from "./states/ct.ts";
import { DE_FACTOR_LABELS } from "./states/de.ts";
import { GA_FACTOR_LABELS } from "./states/ga.ts";
import { HI_FACTOR_LABELS } from "./states/hi.ts";
import { IA_FACTOR_LABELS } from "./states/ia.ts";
import { ID_FACTOR_LABELS } from "./states/id.ts";
import { IL_FACTOR_LABELS } from "./states/il.ts";
import { IN_FACTOR_LABELS } from "./states/in.ts";
import { KS_FACTOR_LABELS } from "./states/ks.ts";
import { KY_FACTOR_LABELS } from "./states/ky.ts";
import { LA_FACTOR_LABELS } from "./states/la.ts";
import { MA_FACTOR_LABELS } from "./states/ma.ts";
import { MD_FACTOR_LABELS } from "./states/md.ts";
import { ME_FACTOR_LABELS } from "./states/me.ts";
import { MI_FACTOR_LABELS } from "./states/mi.ts";
import { MN_FACTOR_LABELS } from "./states/mn.ts";
import { MO_FACTOR_LABELS } from "./states/mo.ts";
import { MS_FACTOR_LABELS } from "./states/ms.ts";
import { MT_FACTOR_LABELS } from "./states/mt.ts";
import { NC_FACTOR_LABELS } from "./states/nc.ts";
import { ND_FACTOR_LABELS } from "./states/nd.ts";
import { NE_FACTOR_LABELS } from "./states/ne.ts";
import { NJ_FACTOR_LABELS } from "./states/nj.ts";
import { NM_FACTOR_LABELS } from "./states/nm.ts";
import { NY_FACTOR_LABELS } from "./states/ny.ts";
import { OH_FACTOR_LABELS } from "./states/oh.ts";
import { OK_FACTOR_LABELS } from "./states/ok.ts";
import { OR_FACTOR_LABELS } from "./states/or.ts";
import { PA_FACTOR_LABELS } from "./states/pa.ts";
import { RI_FACTOR_LABELS } from "./states/ri.ts";
import { SC_FACTOR_LABELS } from "./states/sc.ts";
import { UT_FACTOR_LABELS } from "./states/ut.ts";
import { VA_FACTOR_LABELS } from "./states/va.ts";
import { VT_FACTOR_LABELS } from "./states/vt.ts";
import { WI_FACTOR_LABELS } from "./states/wi.ts";
import { WV_FACTOR_LABELS } from "./states/wv.ts";
import { US_LOCAL_FACTOR_LABELS } from "./withholding.ts";
import { US_EMPLOYEE_FACTS } from "./employee-facts.ts";

/**
 * Names for the stub-line mirror factors (`SIT_<code>` / `LIT_<code>`) no
 * static map can enumerate: the codes include operator-entered sub-region
 * certificates (an Ohio school district, a Michigan city), so the set is
 * open-ended. A registered engine names its own code; anything else keeps
 * the code in the label, because the code is the employer-entered
 * jurisdiction the amount was withheld for.
 */
function usDescribeFactor(key: string): string | null {
  const match = /^(SIT|LIT)_(.+)$/.exec(key);
  if (!match) return null;
  const level = match[1];
  const code = match[2]!;
  const engine = usStateWithholding(code);
  if (engine) return `${engine.label} withheld`;
  return level === "SIT"
    ? `State income tax withheld (${code})`
    : `Local income tax withheld (${code})`;
}

/**
 * The United States payroll country pack — registered and installable.
 *
 * Pub 15-T for federal withholding, FICA and FUTA, plus ./states for the
 * state engines and ./states/local-rates.ts for local income tax; the W-4
 * certificates; and the reciprocity declarations.
 *
 * Extracted from an object literal inside `../packs.ts` together with the
 * Canada pack, for the reasons recorded in ../canada/pack.ts. The extraction
 * was behaviour-preserving: same object, same key order, same values, with
 * `CALENDAR_TAX_YEAR` inlined the way every other pack declares it.
 */
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


/**
 * Display name per state postal code, for pickers and labels. USPS
 * Publication 28, Appendix B ("State Abbreviations"): the postal code is
 * the addressing fact and the name is what a person reads. Declared here —
 * beside the coverage that reads it — so no generic layer maps codes to
 * names.
 */
const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const US_REGIONS: PayrollRegionCoverage = {
  label: "state",
  known: US_STATES,
  regionNames: US_STATE_NAMES,
  /**
   * DERIVED, never a second literal list. It is the states whose income tax the
   * pack computes end to end PLUS the states that levy none — and the previous
   * hand-maintained literal was all nine of the second kind and none of the
   * first, which nothing in the codebase could tell. A state gains support by
   * registering an engine, not by somebody remembering to edit an array.
   */
  supported: supportedUsStates(),
  unsupportedReason:
    "{region} income tax withholding is not implemented by the US payroll pack. Transcribe the "
    + "state's published withholding tables into engine/src/payroll/us/states/ and register the "
    + `engine. Implemented: ${implementedUsStates().join(", ")}.`,
};

export const US_PAYROLL_PACK: PayrollCountryPack = {
  country: "US",
  name: "United States",
  // SSA Handbook §101: "A Social Security Number (SSN) is a nine digit
  // number SSA assigns" — "a three-digit number followed by a two-digit
  // number and ending with a four-digit number" (XXX-XX-XXXX). Both the bare
  // nine digits and the hyphenated card presentation validate as given;
  // anything else (letters, partial strips) is refused. Needed for the W-2.
  employeeIdentifier: {
    label: "SSN",
    pattern: "(?:\\d{3}-\\d{2}-\\d{4}|\\d{9})",
    formatHelp: "9 digits, commonly written XXX-XX-XXXX",
    example: "123-45-6789",
    requiredForPayroll: true,
    neededFor: "W-2",
    citation: "SSA Handbook §101: 'A Social Security Number (SSN) is a nine digit number SSA assigns'",
    numericEntry: false,
  },
  installable: true,
  // Pub 15-T produces USD; the IRS tax year is the calendar year.
  statutoryCurrency: "USD",
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: US_REGIONS,
  jurisdictions: US_JURISDICTIONS,
  // Federal deposits ride EFTPS; no single remittance vendor is configured,
  // so US statutory withholdings surface unassigned until one is.
  remittanceVendorSettingsKey: null,
  // Back pay is SUPPLEMENTAL WAGES under Pub 15-T (§7), taxed by the
  // supplemental method rather than annualized with the period's regular
  // wages — the same non-periodic path the engine already implements.
  retroactivePayTreatment: "non_periodic",
  contributoryBases: {
    pensionable: "FICA (Social Security and Medicare) wages",
    insurable: "FUTA and state unemployment (SUI) wages",
  },
  // Post-tax under the IRC: union dues stopped being deductible for
  // employees with the TCJA (2018). No treatment.
  employeeUnionDuesTaxTreatment: null,
  deductionTreatments: [
    // §125 cafeteria and 401(k) elective deferrals reduce FIT-able wages but
    // NOT Social Security or Medicare wages — so only `income` is named.
    // Engine coverage, stated exactly: the state path honors these today via
    // `deduction()` (tax-qualified deductions, e.g. the Nebraska minimum
    // measured on gross wages after qualified deductions); FIT prices the
    // reported wages and FICA/FUTA price their own legs, so wiring FIT to
    // the reduced leg is a separate, untranscribed change — the declaration
    // states the law, it does not claim the FIT engine models it.
    // Labels name the pack's own instruments: the shared catalog keys
    // (options.payTaxTreatment.*) carry the Canadian factor names, so the US
    // treatments state their own English labels and no labelKey.
    {
      key: "pension_f",
      label: "Pension (401(k) elective deferral)",
      help: "401(k) elective deferrals: reduce FIT-able wages, not Social Security or Medicare wages.",
      reduces: ["income"],
    },
    {
      key: "union_dues",
      label: "Union dues (pre-tax)",
      help: "Pre-tax union dues: reduce FIT-able wages where the state honors them, not Social Security or Medicare wages.",
      reduces: ["income"],
    },
    {
      key: "alimony",
      label: "Alimony (pre-2019)",
      help: "Pre-2019 alimony: reduce FIT-able wages where the state honors them, not Social Security or Medicare wages.",
      reduces: ["income"],
    },
  ],
  filings: usPackFilings,
  statutoryRates: US_PACK_RATES,
  taxYears: US_TAX_YEARS,
  certificates: () => US_CERTIFICATES,
  // FICA and FUTA exemption are profile FACTS the US engine reads straight
  // off the profile columns (compute-statutory.ts): no employee-filed form
  // sets them, so no certificate declares them. The CA pack needs no member
  // here — its exemptions are TD1 flag fields.
  profileExemptionFlags: [
    {
      column: "fica_exempt",
      label: "FICA exempt",
      help: "No Social Security or Medicare tax is withheld or matched for this "
        + "employee: the employment is exempt under the IRC (for example a "
        + "qualifying student employee). Income tax withholding is unaffected.",
    },
    {
      column: "futa_exempt",
      label: "FUTA/SUI exempt",
      help: "No federal or state unemployment tax is computed for this employee: "
        + "the employment is exempt under 26 U.S.C. §3306(c). Income tax and "
        + "FICA withholding are unaffected.",
    },
  ],
  withholding: () => US_WITHHOLDING,
  reciprocity: () => US_RECIPROCITY,
  // Withheld FICA dollars the Massachusetts retirement-contribution
  // subtraction reads for a mid-year adopter.
  openingYtdFields: () => US_OPENING_YTD_FIELDS,
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
    {
      key: "state_income_tax",
      components: [
        // A state's income tax is computed from state-taxable wages after
        // pre-tax deductions, so a §125 or 401(k) order moves it exactly as
        // it moves the federal line — assessedOn 'taxable_income', which is
        // what makes the deduction-protection fixpoint re-derive it.
        //
        // ONE component for every state, with the jurisdiction on the LINE
        // (its description and the stub's factors), not one component per
        // state. A component per state would be fifty rows in a table an
        // operator reads, forty of them always empty, and it still would not
        // answer the remittance question — state withholding is remitted per
        // REGISTRATION (a payroll_filing_account), which is a different axis
        // from the component. Remittance is 'external': a state's
        // withholding goes to the state, never to the federal vendor.
        { code: "SIT", name: "State income tax", systemKey: "state_income_tax", kind: "deduction", sequence: 140, assessedOn: "taxable_income", remittance: "external" },
      ],
    },
    {
      key: "local_income_tax",
      components: [
        // The taxing unit BELOW the state: New York City, Yonkers,
        // Philadelphia, an Ohio municipality or school district, a Michigan
        // city. Its own slot rather than the state's, because it is remitted
        // to a different authority — the City of Philadelphia is not the
        // Commonwealth of Pennsylvania — and an employer posting both to one
        // payable cannot reconcile either.
        { code: "LIT", name: "Local income tax", systemKey: "local_income_tax", kind: "deduction", sequence: 145, assessedOn: "taxable_income", remittance: "external" },
      ],
    },
  ],
  computeStatutory: computeUsStatutory,
  statutoryEngineLabel: "Pub 15-T",
  // Pack-declared trace labels, aggregated from the modules that trace
  // them: Pub 15-T, one map per state engine, the local-rate dispatch, and
  // the compute pass's own inputs. Open-ended SIT_/LIT_ mirrors resolve
  // through describeFactor below.
  factorLabels: {
    ...PUB15T_FACTOR_LABELS,
    ...AL_FACTOR_LABELS,
    ...AR_FACTOR_LABELS,
    ...AZ_FACTOR_LABELS,
    ...CA_FACTOR_LABELS,
    ...CO_FACTOR_LABELS,
    ...CT_FACTOR_LABELS,
    ...DE_FACTOR_LABELS,
    ...GA_FACTOR_LABELS,
    ...HI_FACTOR_LABELS,
    ...IA_FACTOR_LABELS,
    ...ID_FACTOR_LABELS,
    ...IL_FACTOR_LABELS,
    ...IN_FACTOR_LABELS,
    ...KS_FACTOR_LABELS,
    ...KY_FACTOR_LABELS,
    ...LA_FACTOR_LABELS,
    ...MA_FACTOR_LABELS,
    ...MD_FACTOR_LABELS,
    ...ME_FACTOR_LABELS,
    ...MI_FACTOR_LABELS,
    ...MN_FACTOR_LABELS,
    ...MO_FACTOR_LABELS,
    ...MS_FACTOR_LABELS,
    ...MT_FACTOR_LABELS,
    ...NC_FACTOR_LABELS,
    ...ND_FACTOR_LABELS,
    ...NE_FACTOR_LABELS,
    ...NJ_FACTOR_LABELS,
    ...NM_FACTOR_LABELS,
    ...NY_FACTOR_LABELS,
    ...OH_FACTOR_LABELS,
    ...OK_FACTOR_LABELS,
    ...OR_FACTOR_LABELS,
    ...PA_FACTOR_LABELS,
    ...RI_FACTOR_LABELS,
    ...SC_FACTOR_LABELS,
    ...UT_FACTOR_LABELS,
    ...VA_FACTOR_LABELS,
    ...VT_FACTOR_LABELS,
    ...WI_FACTOR_LABELS,
    ...WV_FACTOR_LABELS,
    ...US_LOCAL_FACTOR_LABELS,
    ...US_COMPUTE_FACTOR_LABELS,
  },
  describeFactor: usDescribeFactor,
  employeeFacts: US_EMPLOYEE_FACTS,
};
