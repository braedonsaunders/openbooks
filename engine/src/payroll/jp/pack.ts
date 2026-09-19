/**
 * The Japan payroll pack (`installable: true` — 2026 computes end to end
 * and the adapter test proves a monthly 甲欄 payslip computes AND pushes
 * all five lines through the declaration-enforcing push path).
 *
 * Declares 源泉徴収 withholding income tax (NTA), 厚生年金 employee +
 * employer shares (JPS), and 健康保険 employee + employer shares (insurer
 * rate via tenant slot) as statutory slots, the 扶養控除等申告書
 * certificate, the 47-prefecture region coverage, and the 国民の祝日
 * calendar. Calendar 2026 is transcribed — the NTA 令和8年分 月額表
 * (甲欄 0–7人 + 乙欄) and the JPS 厚生年金保険料額表（令和8年度版) live in
 * ./tables-2026.ts and ./pension-2026.ts, priced by ./withholding-2026.ts.
 *
 * Two authorities share the money — the NTA (国税庁) takes the 源泉徴収
 * income tax, the Japan Pension Service (日本年金機構) and the health
 * insurer take the social-insurance premiums — so no single statutory
 * vendor is named (`remittanceVendorSettingsKey: null`, like the FR and US
 * packs). Gensen surfaces unassigned under `tax_authority`; pension and
 * health ride `external` per-component destinations (the employer's JPS /
 * insurer account, which varies by insurer the way a French caisse does).
 *
 * REGISTERED: `PayrollCountry` is `keyof typeof PAYROLL_COUNTRY_PACKS`, so
 * `country: "JP"` typechecks directly and this pack is in the registry,
 * wired to no settings key (null vendor), and installable.
 */
import type {
  PayrollCountryPack,
  PayrollRegionCoverage,
} from "../packs.ts";
import { JP_CERTIFICATES } from "./certificates.ts";
import { computeJpStatutory, JP_FACTOR_LABELS } from "./compute-statutory.ts";
import { jpPackFilings } from "./filings.ts";
import { JP_JURISDICTIONS } from "./jurisdictions.ts";
import { JP_PACK_RATES, JP_TAX_YEARS } from "./rates.ts";
import { JP_PREFECTURE_CODES } from "./regions.ts";
import { JP_WITHHOLDING } from "./withholding.ts";

/** Structural conformance for the registry entry. */
export type JpPayrollPack = PayrollCountryPack & {
  country: "JP";
};

// ---------------------------------------------------------------------------
// Regions: prefecture is the axis, and the missing rate is a rate-channel
// refusal — never an empty `supported`.
//
// Health-insurance rates VARY BY PREFECTURE (each 協会けんぽ 都道府県支部
// deliberates its own rate yearly; employers in a 健康保険組合 pay their
// union's own rate instead), so a withholding engine must know the
// employment prefecture before it can compute a number. That makes
// prefecture the `regions` axis.
//
// But `supported` does NOT ask "does the pack publish this prefecture's
// table" — it asks whether the ENGINE computes the prefecture's income tax
// end to end (see ../installable-region-coverage.test.ts: France and Italy
// shipped installable with `supported: []` and could pay nobody). This
// engine computes every prefecture identically once that prefecture's
// health rate is known, so all 47 are supported and a missing rate is
// refused at the rate channel (compute-statutory.ts names the prefecture),
// the way Italy's addizionale works. Emptying `supported` to express "we
// do not publish their table" would refuse the whole country at Link 4
// before a line is computed.
// ---------------------------------------------------------------------------

const JP_REGIONS: PayrollRegionCoverage = {
  label: "prefecture",
  known: JP_PREFECTURE_CODES,
  supported: JP_PREFECTURE_CODES,
  unsupportedReason:
    "income tax withholding for prefecture {region} is not implemented: the JP payroll pack "
    + "computes 源泉徴収 plus 厚生年金 and 健康保険 for every JIS prefecture, so reaching this "
    + "message means {region} is not a known JIS X 0401 code.",
};

export const JP_PAYROLL_PACK: JpPayrollPack = {
  country: "JP",
  name: "Japan",
  // Digital Agency / Cabinet Office (My Number system): every resident holds
  // a 12-digit Individual Number ("My Number") for social security and tax.
  // Length and digit shape only — the check digit is NOT enforced (unsourced
  // here). Needed for the statutory withholding records (法定調書).
  employeeIdentifier: {
    label: "My Number",
    pattern: "\\d{12}",
    formatHelp: "12 digits",
    example: "123456789012",
    requiredForPayroll: true,
    neededFor: "statutory withholding records",
    citation: "Digital Agency: every resident holds a 12-digit Individual Number (My Number) for social security and tax",
    numericEntry: true,
  },
  installable: true,
  // The pack computes in yen; gensen, pension and health all settle in yen.
  statutoryCurrency: "JPY",
  // Japan's tax year is the calendar year (暦年); the social-insurance year
  // runs on its own 定時決定 cycle, but the pack's tax-year gate is the
  // calendar year the 月額表 prices.
  taxYear: { basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year" },
  regions: JP_REGIONS,
  jurisdictions: JP_JURISDICTIONS,
  // Two authorities, no single vendor: gensen goes to the NTA (tax office),
  // pension to the JPS and health to the 協会けんぽ branch or 健康保険組合.
  // Null until Orchestrate adds NTA/JPS remittance-party settings fields.
  remittanceVendorSettingsKey: null,
  // Retroactive salary differentials (給与の改訂差額) join the payment
  // month's 給与等の金額 for 月額表 lookup — taxed as ordinary income of
  // the period paid, with no annualization and no bonus method. The 月額表
  // system has no non-periodic arm for salary; the 賞与算出率の表 (a
  // different table, untranscribed) prices bonuses, not arrears.
  retroactivePayTreatment: "periodic",
  contributoryBases: {
    pensionable: "厚生年金保険の標準報酬の対象となる報酬 (pensionable remuneration feeding the 標準報酬月額)",
    // No second compulsory employee contribution is priced by this pack:
    // 雇用保険 is refused by name, so the flag accumulates nothing here
    // rather than inheriting another jurisdiction's EI/FUTA meaning.
    insurable: "unused — no employee-paid contribution is assessed on a separate insurable base",
  },
  // Union dues ride the pay slip, but whether any statute deducts them at
  // source was not established in this pass — so null (no tax treatment)
  // until sourced, never a guessed factor.
  employeeUnionDuesTaxTreatment: null,
  // No pre-tax treatment transcribed: the engine prices withholding off
  // gross, so the pack declares an empty vocabulary rather than an
  // unhonored one.
  deductionTreatments: [],
  filings: jpPackFilings,
  statutoryRates: JP_PACK_RATES,
  taxYears: JP_TAX_YEARS,
  certificates: () => JP_CERTIFICATES,
  withholding: () => JP_WITHHOLDING,
  statutorySlots: [
    {
      key: "gensen",
      components: [
        // 源泉徴収 is looked up on pay AFTER social-insurance premiums —
        // a protected pre-tax deduction moves it, so taxable_income,
        // re-derived every fixpoint pass like T4127-T/FIT/IRPF.
        { code: "GENSEN", name: "源泉徴収 (withholding income tax)", systemKey: "income_tax", kind: "deduction", sequence: 110, assessedOn: "taxable_income", remittance: "tax_authority" },
      ],
    },
    {
      key: "kosei_nenkin",
      components: [
        // 厚生年金: the 折半額 off the 標準報酬 grade — no deduction enters
        // the formula, both shares. External: the destination is the
        // employer's JPS account, configured per component.
        { code: "KOSEI", name: "厚生年金保険 (employee)", systemKey: "pension", kind: "deduction", sequence: 120, assessedOn: "earnings", remittance: "external" },
        { code: "KOSEI-ER", name: "厚生年金保険 (employer)", systemKey: "pension", kind: "employer_contribution", sequence: 220, assessedOn: "earnings", remittance: "external" },
      ],
    },
    {
      key: "kenko_hoken",
      components: [
        // 健康保険: grade × tenant rate, halved per the 50銭 rule — no
        // deduction enters the formula, both shares. External: the
        // destination is the employer's 協会けんぽ/組合 account.
        { code: "KENKO", name: "健康保険 (employee)", systemKey: "health", kind: "deduction", sequence: 130, assessedOn: "earnings", remittance: "external" },
        { code: "KENKO-ER", name: "健康保険 (employer)", systemKey: "health", kind: "employer_contribution", sequence: 230, assessedOn: "earnings", remittance: "external" },
      ],
    },
  ],
  computeStatutory: computeJpStatutory,
  factorLabels: { ...JP_FACTOR_LABELS },
  // The withholding computation lives under the 月額表 statute itself:
  // 所得税法第185条 (the table) under the 源泉徴収 duty of 第183条.
  statutoryEngineLabel: "月額表",
};
