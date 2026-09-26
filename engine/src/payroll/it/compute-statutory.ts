/**
 * The IT pack's statutory pass for tax years 2025 and 2026 (anni d'imposta).
 *
 * Method (engine-stated where the agency is silent): annualise the period's
 * pay (gross x periodsPerYear, one-off non-periodic added once), compute the
 * ANNUAL liability — IRPEF scaglioni on the imponibile, art. 13 detrazione
 * lavoro dipendente plus the +65 euro c. 2 increase, the L. 207/2024 c. 6
 * ulteriore detrazione, INPS IVS 9,19/23,81 with prima fascia and post-1995
 * massimale, the declared-rate addizionali, the trattamento integrativo and
 * the c. 4 somma payouts — then divide back to the period, rounded half-up
 * to the cent per the CU istruzioni (quoted in tax-year-2025.ts, carried in
 * tax-year-2026.ts pending CU 2027). The division rounding is the engine's
 * own rule; the agency states per-amount cent rounding only.
 *
 * The two years share one engine (`calculateItWithTables`): the 2026 Budget
 * changed the second IRPEF bracket (35% -> 33%) and the INPS annual values
 * but no formula, so each year's module carries only constants and the
 * computation reads them through `ItYearTables`. A year whose tables are
 * not transcribed is refused by name before any rate is touched.
 *
 * What the engine assumes (stated, not hidden): a full-year worker at this
 * pay unless taxYearWorkDays carries the actual employment days, in which
 * case the art. 13 and c. 6 detrazioni rapportano; no presumption data beyond
 * the dichiarazione's reddito presunto (which raises the complessivo
 * thresholds when higher); ctx.region is read
 * as the fiscal domicile region (surcharges follow the domicile, never the
 * workplace — withholding.ts); the c. 4 somma band is read off the
 * theoretical gross annual while the percentage applies to the net lavoro
 * base (Circ. 4/E Esempio 3). Multi-employer conguaglio, monthly
 * mensilizzazione of the 1% additional, acconto/saldo instalments, and the
 * 10-rate recovery of indebiti are year-end/timing mechanics the per-period
 * engine does not model — refused by name (IT_REFUSED_2025 / IT_REFUSED_2026).
 *
 * Deliberately NOT called: the `ctx.assertRegionSupported` callback. This pass
 * runs for any known ISTAT region, and an unconfigured surtax rate is a
 * refusal naming the scope point — a pack that computes the surtax from a
 * guessed rate is wrong money.
 *
 * Year notes that are NOT engine branches: the 2026 sterilizzazione above
 * 200.000 (L. 199/2025 c. 4) reduces only the art. 16-ter oneri detrazioni
 * the engine does not carry, so high incomes compute normally (pinned); the
 * 2026-only 5%/15% substitute regimes price components the engine has no
 * inputs for, so pay carrying those facts is refused by name under
 * IT_REFUSED_2026 rather than computed (enforceIt2026SubstituteRegimes).
 * The c. 18–21 tourism speciale is the exception: it prices from the
 * it_turismo_speciale attestation (IT-TOURISM-2026-IMPL) and refuses only
 * unattested or out-of-window claims.
 *
 * Declining the callback is NOT a reason to empty `regions.supported`: Link 4
 * of resolveEmployeePayrollContext gates every employee on that list whatever
 * the pack does here. All 20 regions are listed (see ./pack.ts).
 *
 * The trattamento integrativo and c. 4 somma payouts are pushed as generic
 * `credit` lines (ti_payout/somma_payout, pack-local components on the IRPEF
 * slot): money the employer pays the worker and recovers via F24, which is
 * why the stub lines and the TI/SOMMA factors below carry the same period
 * amounts — year-to-date reads the factors, so YTD matches cash by
 * construction.
 *
 * Money: bigint units (1e4) throughout, halves away from zero, via the
 * repo's money.ts — the same discipline as canada/decimal.ts. Ratios are
 * TRUNCATED to 4 decimals per 730/2026 TABELLA 6 note (2) (carried for 2026).
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import { IT_PACK_RATES } from "./rates.ts";
import { IT_REGION_CODES } from "./regions.ts";
import { ItPayrollRefusal } from "./refusal.ts";
import { pushItSurtaxSaldoInstallments } from "./surtax-balances.ts";
import {
  IT_2025_DETRAZIONE_C2,
  IT_2025_DETRAZIONE_LAVORO,
  IT_2025_INPS_IVS,
  IT_2025_IRPEF_BANDS,
  IT_2025_MASSIMALE_POST1995,
  IT_2025_MINIMALE,
  IT_2025_PRIMA_FASCIA,
  IT_2025_RATIO_DECIMALS,
  IT_2025_SOMMA,
  IT_2025_TRATTAMENTO_INTEGRATIVO,
  IT_2025_ULTERIORE_DETRAZIONE,
} from "./tax-year-2025.ts";
import {
  IT_2026_BOLZANO_DETRAZIONE,
  IT_2026_DETRAZIONE_C2,
  IT_2026_DETRAZIONE_LAVORO,
  IT_2026_INPS_IVS,
  IT_2026_IRPEF_BANDS,
  IT_2026_MASSIMALE_POST1995,
  IT_2026_MINIMALE,
  IT_2026_PRIMA_FASCIA,
  IT_2026_RATIO_DECIMALS,
  IT_2026_SOMMA,
  IT_2026_TRATTAMENTO_INTEGRATIVO,
  IT_2026_ULTERIORE_DETRAZIONE,
} from "./tax-year-2026.ts";

export { ItPayrollRefusal } from "./refusal.ts";

/**
 * One transcribed year's tables, in the single shape the shared engine
 * reads. Both year modules conform to it: a new edition adds a module plus
 * one `IT_<year>_TABLES` entry, never a branch in the computation.
 */
export interface ItYearTables {
  readonly year: number;
  readonly refusedListName: string;
  readonly bands: readonly { readonly upTo: string | null; readonly rate: string }[];
  readonly ratioDecimals: number;
  readonly massimalePost1995: string;
  readonly minimaleGiornaliero: string;
  readonly primaFascia: {
    readonly annual: string;
    readonly monthly: string;
    readonly additionalWorker: string;
  };
  readonly inpsIvs: { readonly total: string; readonly worker: string; readonly employer: string };
  readonly detrazioneLavoro: {
    readonly bandA_cap: string;
    readonly bandA_amount: string;
    readonly floor: string;
    readonly floorFixedTerm: string;
    readonly bandB_cap: string;
    readonly bandB_base: string;
    readonly bandB_factor: string;
    readonly bandB_span: string;
    readonly bandC_cap: string;
    readonly bandC_base: string;
    readonly bandC_span: string;
  };
  readonly detrazioneC2: { readonly amount: string; readonly fromExclusive: string; readonly toInclusive: string };
  readonly ulterioreDetrazione: {
    readonly amount: string;
    readonly bandA_fromExclusive: string;
    readonly bandA_toInclusive: string;
    readonly bandB_toExclusive: string;
    readonly bandB_span: string;
  };
  readonly somma: {
    readonly incomeCap: string;
    readonly bands: readonly { readonly upTo: string | null; readonly rate: string }[];
  };
  readonly trattamentoIntegrativo: {
    readonly amount: string;
    readonly incomeCap: string;
    readonly detrazioneReduction: string;
  };
  /**
   * The transcribed Provincia autonoma di Bolzano detrazione on the
   * addizionale regionale (amount against the rate-priced surtax, through
   * the income cap). Null when the year transcribes none — the refused list
   * then names regional detrazioni as untranscribed instead of pricing them
   * as zero. Applied only on an explicit Bolzano domicile attribution (the
   * "04" region code covers Trento too, on its own timetable).
   */
  readonly bolzanoDetrazione: {
    readonly amount: string;
    readonly incomeCap: string;
  } | null;
}

export const IT_2025_TABLES: ItYearTables = {
  year: 2025,
  refusedListName: "IT_REFUSED_2025",
  bands: IT_2025_IRPEF_BANDS,
  ratioDecimals: IT_2025_RATIO_DECIMALS,
  massimalePost1995: IT_2025_MASSIMALE_POST1995,
  minimaleGiornaliero: IT_2025_MINIMALE.giornaliero,
  primaFascia: IT_2025_PRIMA_FASCIA,
  inpsIvs: IT_2025_INPS_IVS,
  detrazioneLavoro: IT_2025_DETRAZIONE_LAVORO,
  detrazioneC2: IT_2025_DETRAZIONE_C2,
  ulterioreDetrazione: IT_2025_ULTERIORE_DETRAZIONE,
  somma: IT_2025_SOMMA,
  trattamentoIntegrativo: IT_2025_TRATTAMENTO_INTEGRATIVO,
  // 2025 transcribes no regional detrazione: regional relief stays on the
  // refused list rather than pricing as zero.
  bolzanoDetrazione: null,
};

export const IT_2026_TABLES: ItYearTables = {
  year: 2026,
  refusedListName: "IT_REFUSED_2026",
  bands: IT_2026_IRPEF_BANDS,
  ratioDecimals: IT_2026_RATIO_DECIMALS,
  massimalePost1995: IT_2026_MASSIMALE_POST1995,
  minimaleGiornaliero: IT_2026_MINIMALE.giornaliero,
  primaFascia: IT_2026_PRIMA_FASCIA,
  inpsIvs: IT_2026_INPS_IVS,
  detrazioneLavoro: IT_2026_DETRAZIONE_LAVORO,
  detrazioneC2: IT_2026_DETRAZIONE_C2,
  ulterioreDetrazione: IT_2026_ULTERIORE_DETRAZIONE,
  somma: IT_2026_SOMMA,
  trattamentoIntegrativo: IT_2026_TRATTAMENTO_INTEGRATIVO,
  bolzanoDetrazione: IT_2026_BOLZANO_DETRAZIONE,
};

const U = (s: string | number): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);
const CENT = 100n;
const ZERO = 0n;

/** Round units half-up to the cent (CU istruzioni rule, carried for 2026). */
export function r2(u: bigint): bigint {
  return roundDiv(u, CENT) * CENT;
}

/** amount x fraction, both exact (fraction as decimal string, e.g. "0.23"). */
function mulFrac(u: bigint, frac: string): bigint {
  return (u * U(frac)) / 10_000n;
}

/** amount x percent-number (e.g. "0.8" for 0,8%), exact. */
export function mulPct(u: bigint, pct: string): bigint {
  return (u * U(pct)) / (100n * 10_000n);
}

const max0 = (u: bigint): bigint => (u < ZERO ? ZERO : u);
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Truncate a non-negative ratio num/den to the year's decimals (730/2026
 * TABELLA 6 note 2, carried for 2026: "lo stesso si assume nelle prime 4
 * cifre decimali").
 */
function truncRatio4(num: bigint, den: bigint, decimals: number): bigint {
  if (num <= ZERO) return ZERO;
  if (den <= ZERO) throw new PayrollError("ratio denominator must be greater than zero");
  return (num * 10n ** BigInt(decimals)) / den;
}

function marginalTax(
  baseUnits: bigint,
  bands: ItYearTables["bands"],
): bigint {
  let tax = ZERO;
  let lower = ZERO;
  for (const band of bands) {
    if (baseUnits <= lower) break;
    const upper = band.upTo === null ? baseUnits : bmin(baseUnits, U(band.upTo));
    tax += mulFrac(upper - lower, band.rate);
    lower = band.upTo === null ? baseUnits : U(band.upTo);
  }
  return tax;
}

/**
 * Progressive addizionale from deliberated scaglioni: the
 * same marginal walk, but bracket rates are percent numbers like the scalar
 * slot ("1.23" for 1,23%), not fractions.
 */
function marginalPctTax(baseUnits: bigint, brackets: readonly ItSurtaxBracket[]): bigint {
  let tax = ZERO;
  let lower = ZERO;
  for (const band of brackets) {
    if (baseUnits <= lower) break;
    const upper = band.upTo === null ? baseUnits : bmin(baseUnits, U(band.upTo));
    tax += mulPct(upper - lower, band.rate);
    lower = band.upTo === null ? baseUnits : U(band.upTo);
  }
  return tax;
}

export interface It2025SurtaxInput {
  /** Percent number as the tenant typed it ("0.8" for 0,8%). */
  rate: string;
  /** EUR exemption threshold, when the comune deliberates one. */
  exemption?: string | null;
}

/**
 * One deliberated surtax bracket: `{ upTo, rate }`, where —
 * unlike the IRPEF bands — `rate` is a percent number like the scalar slot
 * ("1.23" for 1,23%). A null `upTo` is the open top bracket.
 */
export interface ItSurtaxBracket {
  readonly upTo: string | null;
  readonly rate: string;
}

/** 2026 input: identical shape — one engine, two table years. */
export type It2026Input = It2025Input;

/** 2026 surtax input: identical shape. */
export type It2026SurtaxInput = It2025SurtaxInput;

export interface It2025Input {
  /** Annual gross employment pay at this rate (full-year assumption). */
  annualGrossEmployment: string;
  /** Annual pensionable earnings at this rate. */
  annualPensionable: string;
  /** One-off taxable erogazioni (tredicesima mechanics excluded by timing). */
  nonPeriodicAnnual?: string;
  /** Reddito complessivo presunto from the detrazioni declaration, if any. */
  presumedTotalIncome?: string | null;
  periodsPerYear: number;
  /** Domicile regione (ISTAT code); domicile selects, never the workplace. */
  regionCode: string;
  /**
   * Domiciled in the autonomous province of Bolzano/Bozen. The "04" region
   * code covers Trento and Bolzano on different timetables, and no comuni
   * mapping attributes a province — so "04" without this attribution
   * refuses by name, and `true` outside "04" refuses as contradictory.
   * Null elsewhere prices no credit.
   */
  domicileBolzano?: boolean | null;
  /** Domicile comune (codice catastale); null refuses the comunale. */
  comuneCode: string | null;
  /** Declared regionale rate; null refuses (never guessed). */
  regionalRate: string | null;
  /**
   * Deliberated regionale scaglioni: for domiciles whose
   * region publishes a progressive schedule (e.g. Lombardia), the scalar
   * slot cannot represent it and the engine refuses without these. Supplying
   * both a scalar and brackets refuses as ambiguous.
   */
  regionalBrackets?: readonly ItSurtaxBracket[] | null;
  /** Declared comunale rate/exemption; null refuses (never guessed). */
  municipalSurtax: It2025SurtaxInput | null;
  /**
   * Deliberated comunale scaglioni: same progressive
   * treatment for comuni that deliberate by bracket; the soglia exemption
   * still zeroes at-or-below-threshold imponibili first.
   */
  municipalBrackets?: readonly ItSurtaxBracket[] | null;
  /**
   * Days of employment in the tax year: the art. 13
   * detrazione lavoro and the c. 6 ulteriore detrazione are rapportate al
   * periodo di lavoro (730 istruzioni, Table 6). Null/undefined keeps the
   * documented full-year assumption; partial-year payrolls must carry this.
   */
  taxYearWorkDays?: number | null;
  /**
   * Annual eligible fringe benefits excludable under art. 51, up to
   * EUR 1,000, or EUR 2,000 with a
   * dependent child (L. 207/2024 art. 1 c. 390, tax years 2025–2027).
   * Above the cap the whole amount is taxable, so nothing is excluded.
   * Null/undefined prices the whole gross as taxable.
   */
  excludedFringeAnnual?: string | null;
  /** Dependent child for the EUR 2,000 fringe cap (art. 51 only, not art. 12). */
  fringeDependentChild?: boolean;
  /**
   * 2026 CCNL contractual-renewal increases in pay: L.
   * 199/2025 art. 1 c. 7 prices them under a 5% imposta sostitutiva, which
   * the engine does not compute — any positive amount refuses by name.
   */
  renewalIncrease2026?: string | null;
  /**
   * 2026 night/holiday/rest-day/shift allowances in pay: L. 199/2025 art. 1
   * c. 10–11 prices them under a 15% imposta sostitutiva (cap 1.500/year),
   * which the engine does not compute — any positive amount refuses by name.
   */
  shiftAllowances2026?: string | null;
  /**
   * 2026 tourism/hospitality/food-service night and festive work pay
   * (IT-TOURISM-2026-IMPL): qualifying gross for prestazioni 1 January–30
   * September 2026. The engine prices the 15% trattamento integrativo
   * speciale (L. 199/2025 art. 1 c. 18–21, extending L. 207/2024 c. 18–21;
   * AdE Circ. 3/E/2026 FAQ) when the eligibility facts are declared, and
   * refuses by name when they are missing. The qualifying amount stays
   * inside annualGrossEmployment (ordinary taxable); the 15% credit is
   * additional pay outside the IRPEF imponibile.
   */
  tourismSpecialPay2026?: {
    /** Qualifying gross for night/festive prestazioni in the window. */
    readonly amount: string;
    /** Descriptive sector (e.g. "turismo"); the attestation is eligibleSector. */
    readonly sector?: string | null;
    /** Representative work date; must fall in 2026-01-01..2026-09-30. */
    readonly workDate?: string | null;
    /**
     * The employer operates an eligible establishment (somministrazione di
     * alimenti e bevande, turismo, termale). Required true — without it the
     * engine cannot gate the sector and refuses.
     */
    readonly eligibleSector?: boolean;
    /**
     * The worker requested the treatment and self-certified the 2025 income
     * (constitutive per AdE Circ. 3/E/2026). Required true — without it the
     * engine refuses rather than paying an unclaimed credit.
     */
    readonly workerRequested?: boolean;
    /**
     * Autocertified 2025 lavoro income (all employers, cassa allargata to
     * 12 Jan 2026). Above EUR 40,000 the worker is ineligible and the
     * amount stays ordinary taxable (no credit, no refusal).
     */
    readonly priorYearIncome?: string | null;
  } | null;
  /**
   * Theoretical annual lavoro base for the c. 4 somma band (rapportato
   * all'intero anno); defaults to annualGrossEmployment. Circ. 4/E
   * computes the band off the theoretical annual and applies the
   * percentage to the actual imponibile base.
   */
  sommaBandBase?: string | null;
  /** it_detrazioni declaration on file (gates art. 13 + c. 2). */
  hasDetrazioniDeclaration: boolean;
  /**
   * Any declared art. 12 family charge (coniuge/figli/altri a carico).
   * The pack lacks the facts and amounts needed to compute those deductions.
   */
  hasFamilyCharges?: boolean;
  isFixedTerm?: boolean | null;
  /**
   * 2026 substitute-regime amounts for THIS period (euro strings, "0" when
   * none): CCNL-renewal increases (L. 199/2025 c. 7, 5%), night/holiday/shift
   * allowances (c. 10–11, 15%, annual base cap 1.500), performance bonuses
   * (L. 208/2015 c. 182–189 at the 2026–2027 1% rate, annual base cap 5.000).
   * 2026-only: any positive amount with 2025 tables refuses (no legal basis).
   */
  renewalIncrease?: string;
  shiftAllowance?: string;
  premiRisultato?: string;
  /** Realized substitute bases already priced this year (committed stubs). */
  renewalIncreaseYtd?: string;
  shiftAllowanceYtd?: string;
  premiRisultatoYtd?: string;
  /** The worker's 2025 lavoro income: ceiling for the 33.000/40.000 gates. */
  priorYearEmploymentIncome?: string | null;
  /** Whether the declared premi meet the L. 208/2015 regime criteria. */
  premiRisultatoEligible?: boolean | null;
  /** Art. 49 c. 2 lett. a) pension income: refused (TABELLA 7). */
  isPensioner?: boolean;
  /** Post-1995 seniority: the annual massimale applies; absent is unknown. */
  isPost1995?: boolean;
}

/** 2026 result: identical shape. */
export type It2026Result = It2025Result;

export interface It2025Result {
  /** Annual figures, 4dp strings. */
  redditoComplessivo: string;
  imponibileIrpef: string;
  irpefLorda: string;
  detrazioneLavoro: string;
  ulterioreDetrazione: string;
  irpefNetta: string;
  trattamentoIntegrativo: string;
  /** 2026 tourism speciale credit (IT-TOURISM-2026-IMPL), outside IRPEF. */
  trattamentoSpeciale: string;
  somma: string;
  inpsWorker: string;
  inpsEmployer: string;
  addizionaleRegionale: string;
  addizionaleComunale: string;
  /**
   * Substitute-regime figures. Annuals are realized-to-date (ytd + current),
   * not annualized forecasts; period figures are this stub's priced shares.
   */
  sostitutivaRinnoviBase: string;
  sostitutivaRinnovi: string;
  sostitutivaTurniBase: string;
  sostitutivaTurni: string;
  sostitutivaPremiBase: string;
  sostitutivaPremi: string;
  /**
   * This stub's priced bases (capped shares): the YTD accumulation inputs.
   * The annuals above are ytd + priced; these are the priced increment alone.
   */
  sostitutivaRinnoviShare: string;
  sostitutivaTurniShare: string;
  sostitutivaPremiShare: string;
  /** Period figures (annual / periodsPerYear, half-up cent). */
  period: {
    irpef: string;
    inpsWorker: string;
    inpsEmployer: string;
    addizionaleRegionale: string;
    addizionaleComunale: string;
    trattamentoIntegrativo: string;
    trattamentoSpeciale: string;
    somma: string;
    sostitutivaRinnovi: string;
    sostitutivaTurni: string;
    sostitutivaPremi: string;
  };
}

function refuse(message: string): never {
  throw new ItPayrollRefusal(message);
}

/** Days in the tax year for the rapportatura divisor. */
function daysInTaxYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/**
 * Give IT_REFUSED_2026 arms: the 2026-only substitute regimes
 * are declared in the refusal list, and any pay carrying the facts refuses
 * here before ordinary IRPEF prices it at the wrong rate. The c. 18–21
 * tourism speciale is not an arm: it prices in calculateItWithTables
 * (IT-TOURISM-2026-IMPL).
 */
function enforceIt2026SubstituteRegimes(input: It2025Input): void {
  const refused = "IT_REFUSED_2026";
  const positive = (value: string | null | undefined, what: string): bigint => {
    if (value == null || value === "") return ZERO;
    return needNonNegative(value, what, 2026);
  };
  if (positive(input.renewalIncrease2026, "renewalIncrease2026") > ZERO) {
    refuse(
      `IT 2026 refuses ${input.renewalIncrease2026} of contractual-renewal increases in ordinary pay: L. 199/2025 `
      + "art. 1 c. 7 prices them under a 5% imposta sostitutiva (private-sector, 2025 lavoro income ≤ 33.000; "
      + `AdE Circ. 2/E/2026), which the engine does not compute — see ${refused}. Price renewal increases `
      + "outside ordinary IRPEF (pay-run adjustment, engine/src/payroll/run-adjustments.ts)",
    );
  }
  if (positive(input.shiftAllowances2026, "shiftAllowances2026") > ZERO) {
    refuse(
      `IT 2026 refuses ${input.shiftAllowances2026} of night/holiday/rest-day/shift allowances in ordinary pay: `
      + "L. 199/2025 art. 1 c. 10–11 prices them under a 15% imposta sostitutiva (cap 1.500/year; AdE FAQ Circ. "
      + `3/E/2026), which the engine does not compute — see ${refused}. Price qualifying allowances outside `
      + "ordinary IRPEF (pay-run adjustment, engine/src/payroll/run-adjustments.ts)",
    );
  }
  // c. 18–21 tourism speciale is NOT refused here: it prices inside
  // calculateItWithTables from the it_turismo_speciale attestation
  // (IT-TOURISM-2026-IMPL), with constitutive eligibility gates there.
}

function needNonNegative(value: string, what: string, year: number): bigint {
  const u = U(value);
  if (u < ZERO) refuse(`IT ${year} engine needs non-negative ${what}, got ${value}`);
  return u;
}

export function calculateItWithTables(input: It2025Input, tables: ItYearTables): It2025Result {
  const year = tables.year;
  const refused = tables.refusedListName;
  if (input.isPensioner) {
    refuse(
      `IT ${year} engine refuses pension income (art. 49 c. 2 lett. a)): pensionati use the `
      + `TABELLA 7 detrazioni, not transcribed — see ${refused}`,
    );
  }
  if (input.isFixedTerm == null) {
    refuse(
      `IT ${year} refuses: employment term is unknown. A fixed-term contract owes the NASpI add-on `
      + "of 1.40% plus 0.50 percentage points per qualifying renewal, and the required renewal and exemption "
      + "facts are not priced; declare the contract term before calculating payroll.",
    );
  }
  if (input.isFixedTerm) {
    // L. 92/2012 art. 2 c. 28 imposes the employer's 1.40% NASpI add-on
    // plus 0.50 percentage points per qualifying renewal; exclusions also
    // depend on contract facts not carried here. INPS Circ. 13/2023 and
    // Circ. 91/2020:
    // https://www.inps.it/content/dam/inps-site/it/scorporati/circolari-e-messaggi/2023/02/Circolare_14062/Allegati/14019_Circolare-numero-13-del-02-02-2023.pdf
    // https://servizi2.inps.it/servizi/Bussola/VisualizzaDoc.aspx?sVirtualURL=%2FCircolari%2FCircolare+numero+91+del+04-08-2020.htm
    refuse(
      `IT ${year} refuses tempo determinato: NASpI addizionale 1.40% plus 0.50 points per qualifying renewal `
      + "and contract-specific exclusions are not priced — the pack does not carry renewal count or the "
      + `required exemption facts; see ${refused}`,
    );
  }
  // 2026 substitute regimes: price the carved-out bases at their flat rates
  // instead of folding them into ordinary IRPEF. Amounts are this period's;
  // YTD bases are realized amounts already priced this year. Caps bind the
  // ANNUAL base (ytd + current); the priced share is the capped increment.
  // The carve-out below removes realized-to-date capped bases from the
  // ordinary annual estimate, converging exact by year-end and trued at
  // conguaglio; thresholds (detrazioni, TI) still read the inclusive R.
  const rPlus = needNonNegative(input.renewalIncrease ?? "0", "renewalIncrease", year);
  const aPlus = needNonNegative(input.shiftAllowance ?? "0", "shiftAllowance", year);
  const pPlus = needNonNegative(input.premiRisultato ?? "0", "premiRisultato", year);
  const rYtd = needNonNegative(input.renewalIncreaseYtd ?? "0", "renewalIncreaseYtd", year);
  const aYtd = needNonNegative(input.shiftAllowanceYtd ?? "0", "shiftAllowanceYtd", year);
  const pYtd = needNonNegative(input.premiRisultatoYtd ?? "0", "premiRisultatoYtd", year);
  const hasSubst = rPlus > ZERO || aPlus > ZERO || pPlus > ZERO;
  if (hasSubst && year !== 2026) {
    refuse(
      `IT ${year} refuses 2026 substitute-regime pay: the 5%/15%/1% imposte sostitutive have no legal basis `
      + `outside 2026 — see ${refused}`,
    );
  }
  const priorIncome = input.priorYearEmploymentIncome == null || input.priorYearEmploymentIncome === ""
    ? null
    : needNonNegative(input.priorYearEmploymentIncome, "priorYearEmploymentIncome", year);
  if (rPlus > ZERO) {
    // L. 199/2025 art. 1 c. 7: 5% on renewal increases, private-sector, 2025
    // lavoro income ≤ 33.000 (AdE Circ. 2/E/2026). No amount cap.
    if (priorIncome == null) {
      refuse(
        `IT ${year} refuses renewal increases without the 2025 lavoro income: the 33.000 ceiling decides `
        + "eligibility for the 5% substitute tax — declare reddito_lavoro_2025 before pricing; "
        + `see ${refused}`,
      );
    }
    if (priorIncome > U("33000")) {
      refuse(
        `IT ${year} refuses renewal increases for 2025 lavoro income ${D(priorIncome)}: above the 33.000 `
        + "ceiling the 5% substitute tax does not apply — remove the amounts from the substitute channel "
        + "and price them as ordinary wages; "
        + `see ${refused}`,
      );
    }
  }
  if (aPlus > ZERO) {
    // L. 199/2025 art. 1 c. 10–11: 15% on night/holiday/shift allowances,
    // annual base cap 1.500, 2025 lavoro income ≤ 40.000.
    if (priorIncome == null) {
      refuse(
        `IT ${year} refuses shift allowances without the 2025 lavoro income: the 40.000 ceiling decides `
        + "eligibility for the 15% substitute tax — declare reddito_lavoro_2025 before pricing; "
        + `see ${refused}`,
      );
    }
    if (priorIncome > U("40000")) {
      refuse(
        `IT ${year} refuses shift allowances for 2025 lavoro income ${D(priorIncome)}: above the 40.000 `
        + "ceiling the 15% substitute tax does not apply — remove the amounts from the substitute channel "
        + "and price them as ordinary wages; "
        + `see ${refused}`,
      );
    }
  }
  if (pPlus > ZERO && input.premiRisultatoEligible !== true) {
    // L. 208/2015 art. 1 c. 182–189 at the 2026–2027 1% rate, annual base cap
    // 5.000: the incrementality and registered-contract criteria decide.
    refuse(
      `IT ${year} refuses performance bonuses with undeclared regime eligibility: assert `
      + "premi_risultato_ammissibili once the L. 208/2015 criteria are met before pricing the 1% "
      + `substitute tax; see ${refused}`,
    );
  }
  const ALLOW_CAP = U("1500");
  const PREMI_CAP = U("5000");
  const aCapped = bmin(aYtd + aPlus, ALLOW_CAP);
  const pCapped = bmin(pYtd + pPlus, PREMI_CAP);
  const aShare = aCapped - bmin(aYtd, ALLOW_CAP);
  const pShare = pCapped - bmin(pYtd, PREMI_CAP);
  const rBase = rYtd + rPlus;
  // INPS note: renewal increases and shift allowances stay in the pensionable
  // base (retribuzione imponibile). Premi di risultato may carry an INPS
  // exemption within limits — unverified for the 2026 1%/5.000 shape, so the
  // base is untouched and any exemption settles externally for now.
  const substCarve = rBase + aCapped + pCapped;
  const sostRinnovi = r2(mulPct(rPlus, "5"));
  const sostTurni = r2(mulPct(aShare, "15"));
  const sostPremi = r2(mulPct(pShare, "1"));
  if (input.hasFamilyCharges) {
    // TUIR art. 12 deductions vary by relationship, income, age, disability,
    // and allocation between eligible taxpayers. The declaration currently
    // carries only a yes/no flag, so ordinary IRPEF would over-withhold at any
    // income where a deduction is owed. TUIR art. 12 (as amended by
    // D.Lgs. 192/2025) and L. 207/2024 art. 1:
    // https://www.normattiva.it/uri/res/N2Ls?urn:nir:stato:decreto.del.presidente.della.repubblica:1986-12-22;917~art12
    // https://www.normattiva.it/eli/id/2024/12/31/24G00229/CONSOLIDATED/20251219
    // https://www.normattiva.it/atto/caricaDettaglioAtto?atto.codiceRedazionale=25G00202&atto.dataPubblicazioneGazzetta=2025-12-19&qId=&tipoDettaglio=originario
    refuse(
      `IT ${year} refuses a declared art. 12 TUIR family deduction: the pack lacks the dependent's `
      + "relationship, income, age/disability, and deduction-allocation facts needed to calculate it. "
      + `Obtain a supported art. 12 calculation before finalizing the payroll; see ${refused}`,
    );
  }
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    refuse(`IT ${year} annualisation needs a positive integer periodsPerYear, got ${input.periodsPerYear}`);
  }
  if (!IT_REGION_CODES.includes(input.regionCode)) {
    refuse(
      `unknown IT regione "${input.regionCode || "(unset)"}": the IT payroll pack knows `
      + `${IT_REGION_CODES.join(", ")}`,
    );
  }
  if (year === 2026) enforceIt2026SubstituteRegimes(input);
  // Art. 51 fringe exclusion: eligible benefits within the
  // 1.000 / 2.000 cap never enter employment taxable income; above the cap
  // the whole amount is taxable (L. 207/2024 art. 1 c. 390).
  const fringeRaw = input.excludedFringeAnnual == null || input.excludedFringeAnnual === "" ? ZERO : needNonNegative(input.excludedFringeAnnual, "excludedFringeAnnual", year);
  let gross = needNonNegative(input.annualGrossEmployment, "annualGrossEmployment", year);
  if (fringeRaw > ZERO) {
    const fringeCap = U(input.fringeDependentChild ? "2000" : "1000");
    if (fringeRaw <= fringeCap) gross = max0(gross - fringeRaw);
  }
  const oneOff = needNonNegative(input.nonPeriodicAnnual ?? "0", "nonPeriodicAnnual", year);
  const annualPensionable = needNonNegative(input.annualPensionable, "annualPensionable", year);
  // Trattamento integrativo speciale (IT-TOURISM-2026-IMPL): 15% of the
  // qualifying night/festive gross, paid as additional non-imponibile income
  // (L. 199/2025 art. 1 c. 18–21; AdE Circ. 3/E/2026 FAQ). Eligibility is
  // constitutive — sector attestation, worker request with autocertified
  // 2025 income, prestazioni inside 1 Jan–30 Sep 2026 — so qualifying pay
  // with missing facts refuses by name; only a demonstrated over-threshold
  // prior income prices ordinary (no credit).
  let trattamentoSpeciale = ZERO;
  const special = input.tourismSpecialPay2026;
  if (year === 2026 && special != null && special.amount !== "") {
    const qualifying = needNonNegative(special.amount, "tourismSpecialPay2026.amount", year);
    if (qualifying > ZERO) {
      const sector = special.sector ?? "(sector unstated)";
      const date = special.workDate ?? "(date unstated)";
      if (special.eligibleSector !== true) {
        refuse(
          `IT 2026 cannot price ${special.amount} of night/festive pay (${sector}, ${date}) under the trattamento `
          + "integrativo speciale: the eligible establishment was not attested (somministrazione di alimenti e "
          + `bevande, turismo, termale) — see ${refused}. Attest eligibleSector or price the amount as ordinary pay`,
        );
      }
      if (special.workerRequested !== true) {
        refuse(
          `IT 2026 cannot price ${special.amount} of night/festive pay (${sector}, ${date}) under the trattamento `
          + "integrativo speciale: the worker's request with autocertified 2025 income is constitutive (AdE Circ. "
          + `3/E/2026) — see ${refused}. File the request or price the amount as ordinary pay`,
        );
      }
      if (special.workDate == null || special.workDate === "" || special.workDate < "2026-01-01" || special.workDate > "2026-09-30") {
        refuse(
          `IT 2026 cannot price ${special.amount} of night/festive pay (${sector}, ${date}) under the trattamento `
          + "integrativo speciale: the prestazioni must fall in 1 January–30 September 2026 (L. 199/2025 art. 1 "
          + `c. 18) — see ${refused}. Verify the work date, or price out-of-window pay as ordinary`,
        );
      }
      if (special.priorYearIncome == null || special.priorYearIncome === "") {
        refuse(
          `IT 2026 cannot price ${special.amount} of night/festive pay (${sector}, ${date}) under the trattamento `
          + "integrativo speciale: the autocertified 2025 lavoro income (all employers, cassa allargata to "
          + `12 Jan 2026) is missing — see ${refused}. Carry priorYearIncome or price the amount as ordinary pay`,
        );
      }
      // Over EUR 40,000 of 2025 lavoro income the worker is ineligible: the
      // amount stays ordinary taxable and no credit prices (deterministic
      // rule application, not silence).
      if (needNonNegative(special.priorYearIncome, "tourismSpecialPay2026.priorYearIncome", year) <= U("40000")) {
        trattamentoSpeciale = r2(mulPct(qualifying, "15"));
      }
    }
  }
  // The speciale credit is additional compensation, so it enters the INPS
  // pensionable base under the general contribution principle (art. 12
  // L. 153/1969: everything paid in relation to the employment is
  // contributivo absent an explicit exclusion) — stated engine rule; the
  // transcribed sources state the IRPEF exclusion only. It never enters the
  // IRPEF imponibile (c. 18: non concorre alla formazione del reddito).
  const pensBase = annualPensionable + oneOff + trattamentoSpeciale;

  // A full-time year can carry up to 26 contribution days in each of 12
  // months. Below that statutory floor, days in alta, hours/part-time and
  // the applicable CCNL minimum are needed to prorate the actual base.
  // Refuse instead of assuming that every worker has 312 contribution days.
  // https://www.inps.it/it/it/inps-comunica/notizie/dettaglio-news-page.news.2026.02.lavoratori-dipendenti-limite-minimo-di-retribuzione-giornaliera-2026.html
  // https://www.inps.it/it/it/dettaglio-approfondimento.schede-informative.minimali-giornalieri-di-retribuzione.html
  const annualFullTimeMinimum = U(tables.minimaleGiornaliero) * 312n;
  if (annualPensionable > ZERO && annualPensionable < annualFullTimeMinimum) {
    refuse(
      `IT ${year} IVS refuses annual pensionable earnings ${D(annualPensionable)} below the full-time daily-minimum `
      + `base ${D(annualFullTimeMinimum)} (${tables.minimaleGiornaliero} × 26 days × 12 months): contribution days, `
      + "part-time hours and the applicable CCNL minimum are not carried, so the statutory base cannot be prorated safely. "
      + "Provide those contract and period facts or have a qualified Italian payroll provider calculate IVS before posting.",
    );
  }

  // INPS IVS on the pensionable base, with prima fascia and massimale. The
  // post-1995 status selects whether that cap applies; it is never inferred
  // from wages. L. 335/1995 art. 2 c. 18 and INPS Circ. 14/2026:
  // https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1995-08-08;335
  // https://www.inps.it/content/dam/inps-site/it/scorporati/circolari-e-messaggi/2026/02/Circolare_15162/Allegati/16561_Circolare-numero-14-del-09-02-2026.pdf
  if (input.isPost1995 == null && pensBase > U(tables.massimalePost1995)) {
    refuse(
      `IT ${year} IVS base ${D(pensBase)} exceeds the ${tables.massimalePost1995} annual massimale, but `
      + `the employee's anzianita_post_1995 status is unknown — declare whether the worker first joined `
      + "after 31 December 1995 (or opted into the contributory system) before pricing IVS; "
      + "see L. 335/1995 art. 2 c. 18 and the annual INPS massimale",
    );
  }
  const cap = input.isPost1995 ? U(tables.massimalePost1995) : null;
  const ivsBase = cap === null ? pensBase : bmin(pensBase, cap);
  const inpsWorker = r2(mulFrac(ivsBase, tables.inpsIvs.worker))
    + r2(mulFrac(max0(bmin(pensBase, cap ?? pensBase) - U(tables.primaFascia.annual)), tables.primaFascia.additionalWorker));
  const inpsEmployer = r2(mulFrac(ivsBase, tables.inpsIvs.employer));

  // Reddito di lavoro netto (category level, contributions already out) and
  // the complessivo the thresholds read (presunto raises, never lowers).
  const lavoroNet = max0(gross + oneOff - inpsWorker);
  const presunto = input.presumedTotalIncome == null || input.presumedTotalIncome === ""
    ? ZERO
    : needNonNegative(input.presumedTotalIncome, "presumedTotalIncome", year);
  const R = presunto > lavoroNet ? presunto : lavoroNet;

  // Substitute-taxed bases leave ordinary IRPEF (and its addizionali, priced
  // off imponibile below); thresholds above keep reading the inclusive R.
  const imponibile = max0(R - substCarve);
  const irpefLorda = r2(marginalTax(imponibile, tables.bands));

  // Art. 13 detrazione lavoro dipendente (declaration-gated) with the
  // c. 2 +65 euro increase for R > 25.000 through R ≤ 35.000 (art. 13 c. 2
  // TUIR "superiore a 25.000 ... ma non a 35.000", cent-precise).
  const L = tables.detrazioneLavoro;
  let detC1 = ZERO;
  if (R <= U(L.bandA_cap)) {
    detC1 = U(L.bandA_amount);
    const floor = U(input.isFixedTerm ? L.floorFixedTerm : L.floor);
    if (detC1 < floor) detC1 = floor;
  } else if (R <= U(L.bandB_cap)) {
    detC1 = U(L.bandB_base)
      + (U(L.bandB_factor) * truncRatio4(U(L.bandB_cap) - R, U(L.bandB_span), tables.ratioDecimals)) / 10_000n;
  } else if (R <= U(L.bandC_cap)) {
    detC1 = (U(L.bandC_base) * truncRatio4(U(L.bandC_cap) - R, U(L.bandC_span), tables.ratioDecimals)) / 10_000n;
  }
  detC1 = r2(detC1);
  const C2 = tables.detrazioneC2;
  const detC2 = R > U(C2.fromExclusive) && R <= U(C2.toInclusive) ? U(C2.amount) : ZERO;
  let detLavoro = input.hasDetrazioniDeclaration ? detC1 + detC2 : ZERO;

  // L. 207/2024 c. 6 ulteriore detrazione (automatic per Circ. 4/E c. 7;
  // the comma carries no sunset, so it governs every later year unchanged).
  const UD = tables.ulterioreDetrazione;
  let ulteriore = ZERO;
  if (R > U(UD.bandA_fromExclusive) && R <= U(UD.bandA_toInclusive)) {
    ulteriore = U(UD.amount);
  } else if (R > U(UD.bandA_toInclusive) && R < U(UD.bandB_toExclusive)) {
    ulteriore = (U(UD.amount) * truncRatio4(U(UD.bandB_toExclusive) - R, U(UD.bandB_span), tables.ratioDecimals)) / 10_000n;
  }
  ulteriore = r2(ulteriore);

  // Rapportatura al periodo di lavoro: the art. 13
  // detrazione lavoro and the c. 6 ulteriore detrazione scale with days of
  // employment in the tax year (730 istruzioni, Table 6). Absent work-days
  // keep the documented full-year assumption.
  if (input.taxYearWorkDays != null) {
    const yearDays = daysInTaxYear(year);
    if (!Number.isInteger(input.taxYearWorkDays) || input.taxYearWorkDays <= 0 || input.taxYearWorkDays > yearDays) {
      refuse(`IT ${year} rapportatura needs taxYearWorkDays as whole days of employment from 1 to ${yearDays}, got ${input.taxYearWorkDays}`);
    }
    if (input.taxYearWorkDays < yearDays) {
      const workDays = input.taxYearWorkDays;
      const factor = (amount: bigint): bigint => r2(roundDiv(amount * BigInt(workDays), BigInt(yearDays)));
      detLavoro = factor(detLavoro);
      ulteriore = factor(ulteriore);
    }
  }

  // Capienza: detrazioni reduce the imposta lorda, never below zero (AdE:
  // "Deductions are generally applied up to the amount of the tax due").
  const detLavoroCapped = bmin(detLavoro, irpefLorda);
  const ulterioreCapped = bmin(ulteriore, irpefLorda - detLavoroCapped);
  const irpefNetta = irpefLorda - detLavoroCapped - ulterioreCapped;

  // Trattamento integrativo: full 1.200 only at R ≤ 15.000 with capienza
  // over the c. 1 detrazione minus 75 euro; the 15.001–28.000 verifica
  // needs art. 12/15 detrazioni the pack does not carry — refused by name.
  const TI = tables.trattamentoIntegrativo;
  let trattamentoIntegrativo = ZERO;
  if (R <= U(TI.incomeCap)) {
    if (irpefLorda > detC1 - U(TI.detrazioneReduction)) {
      trattamentoIntegrativo = U(TI.amount);
    }
  } else if (R <= U(L.bandB_cap)) {
    // No-family case: detrazione lavoro alone stays below the imposta lorda
    // on the whole (15.000, 28.000] band (max ~3.100 at the left edge vs a
    // lorda that starts at ~3.133 and rises), so the verifica fails and TI
    // is 0 — computed, not refused.
  }

  // L. 207/2024 c. 4 somma (automatic): band off the theoretical annual,
  // percentage on the actual imponibile lavoro base (Circ. 4/E Es. 3; the
  // comma carries no sunset, so it governs every later year unchanged).
  const S = tables.somma;
  let somma = ZERO;
  if (R <= U(S.incomeCap)) {
    const bandBase = input.sommaBandBase == null || input.sommaBandBase === ""
      ? gross
      : needNonNegative(input.sommaBandBase, "sommaBandBase", year);
    const band = S.bands.find((b) => b.upTo === null || bandBase <= U(b.upTo));
    if (!band) refuse(`IT ${year} somma band resolution failed — internal error, not a table gap`);
    somma = r2(mulFrac(lavoroNet, band.rate));
  }

  // Addizionali from declared rates on the IRPEF imponibile. No configured
  // rate is a refusal naming the scope point — never a guessed rate, never
  // a lookup by address.
  const hasRegionalBrackets = (input.regionalBrackets?.length ?? 0) > 0;
  const hasMunicipalBrackets = (input.municipalBrackets?.length ?? 0) > 0;
  if (!hasRegionalBrackets && (input.regionalRate == null || input.regionalRate === "")) {
    refuse(
      `no it_addizionale_regionale rate is configured for regione ${input.regionCode} in ${year} — `
      + "the domicile region's deliberated rate must be entered; the pack computes no surtax without it",
    );
  }
  if (input.comuneCode == null || input.comuneCode === "") {
    refuse(
      `the domicile comune is unknown for regione ${input.regionCode} — the addizionale comunale `
      + "follows the fiscal domicile comune (codice catastale) and the pack attributes none without it",
    );
  }
  if (!/^[A-Z][0-9]{3}$/.test(input.comuneCode)) {
    refuse(
      `domicile comune "${input.comuneCode}" is not a codice catastale (expected one letter and three `
      + "digits, e.g. H501) — the pack looks no rate up by address",
    );
  }
  if (!hasMunicipalBrackets && (input.municipalSurtax == null || input.municipalSurtax.rate === "")) {
    refuse(
      `no it_addizionale_comunale rate is configured for comune ${input.comuneCode} (regione `
      + `${input.regionCode}) in ${year} — the domicile comune's deliberated rate must be entered`,
    );
  }
  // Bracketed deliberations: a domicile whose region or
  // comune deliberates scaglioni cannot be priced from the scalar slot.
  // Lombardia (03) publishes a progressive regionale schedule (1.23% /
  // 1.58% / 1.72% by bracket:
  // https://www.regione.lombardia.it/bollo-auto-e-tributi-regionali/red-addizionale-regionale-irpef),
  // so a scalar Lombardia computation refuses until the deliberated
  // brackets are entered; region 04 has no region-wide schedule at all —
  // Trento and Bolzano deliberate separately, and Bolzano's 2026 EUR 430.50
  // credit through EUR 90,000 (https://finanze.provincia.bz.it/it/addizionale-regionale-irpef-imposta-sul-reddito-delle-persone-fisiche)
  // is transcribed (IT_2026_BOLZANO_DETRAZIONE) and prices only on an
  // explicit Bolzano domicile attribution — so unattributed 04 refuses.
  if (input.regionalRate != null && input.regionalRate !== "" && hasRegionalBrackets) {
    refuse(
      `IT ${year} regionale computation is ambiguous for regione ${input.regionCode}: both a scalar rate `
      + `(${input.regionalRate}) and ${input.regionalBrackets?.length} deliberated brackets were supplied — `
      + `enter one schedule, never both; see ${refused}`,
    );
  }
  if (input.municipalSurtax?.rate != null && input.municipalSurtax.rate !== "" && hasMunicipalBrackets) {
    refuse(
      `IT ${year} comunale computation is ambiguous for comune ${input.comuneCode}: both a scalar rate `
      + `(${input.municipalSurtax.rate}) and ${input.municipalBrackets?.length} deliberated brackets were supplied — `
      + `enter one schedule, never both; see ${refused}`,
    );
  }
  // Regione 04 covers Trento and Bolzano on different timetables and the
  // pack carries no comuni map to tell them apart — so "04" without the
  // Bolzano domicile attribution refuses instead of guessing, and a "true"
  // outside 04 refuses as contradictory.
  if (input.regionCode === "04" && input.domicileBolzano !== true && input.domicileBolzano !== false) {
    refuse(
      `regione 04 needs the Bolzano domicile attribution: the addizionale regionale there is set `
      + `separately by Trento and Bolzano, and the pack attributes no province without it. Declare `
      + `domicilio_bolzano "true" or "false" on the it_detrazioni certificate before calculating; see ${refused}`,
    );
  }
  if (input.domicileBolzano === true && input.regionCode !== "04") {
    refuse(
      `domicilio_bolzano "true" contradicts regione ${input.regionCode}: only the autonomous province `
      + `of Bolzano (regione 04) grants this credit — correct the region or the attribution; see ${refused}`,
    );
  }
  if (input.regionCode === "03" && !hasRegionalBrackets) {
    refuse(
      `IT ${year} refuses a scalar addizionale regionale for Lombardia domicile: the region deliberates a `
      + "progressive scaglioni schedule (1.23% / 1.58% / 1.72% by bracket), which no single rate can represent — "
      + `a scalar silently misprices every Lombardia payroll; see ${refused}. Enter the deliberated brackets as `
      + "regionalBrackets, or price the surtax outside the pack "
      + "(pay-run adjustment, engine/src/payroll/run-adjustments.ts)",
    );
  }
  let addRegionale = hasRegionalBrackets
    ? r2(marginalPctTax(imponibile, input.regionalBrackets ?? []))
    : r2(mulPct(imponibile, input.regionalRate ?? ""));
  const bolzano = tables.bolzanoDetrazione;
  if (input.domicileBolzano === true && bolzano !== null && imponibile <= U(bolzano.incomeCap)) {
    // Capienza, like the national detrazioni above: the credit offsets the
    // surtax owed, never below zero.
    addRegionale = max0(addRegionale - U(bolzano.amount));
  }
  const exemption = input.municipalSurtax?.exemption == null || input.municipalSurtax.exemption === ""
    ? null
    : needNonNegative(input.municipalSurtax.exemption, "municipalExemption", year);
  const addComunale = exemption !== null && imponibile <= exemption
    ? ZERO
    : hasMunicipalBrackets
      ? r2(marginalPctTax(imponibile, input.municipalBrackets ?? []))
      : r2(mulPct(imponibile, input.municipalSurtax?.rate ?? ""));

  const P = BigInt(input.periodsPerYear);
  const per = (annual: bigint): string => D(r2(roundDiv(annual, P * CENT) * CENT));

  return {
    redditoComplessivo: D(R),
    imponibileIrpef: D(imponibile),
    irpefLorda: D(irpefLorda),
    detrazioneLavoro: D(detLavoroCapped),
    ulterioreDetrazione: D(ulterioreCapped),
    irpefNetta: D(irpefNetta),
    trattamentoIntegrativo: D(trattamentoIntegrativo),
    trattamentoSpeciale: D(trattamentoSpeciale),
    somma: D(somma),
    inpsWorker: D(inpsWorker),
    inpsEmployer: D(inpsEmployer),
    addizionaleRegionale: D(addRegionale),
    addizionaleComunale: D(addComunale),
    sostitutivaRinnoviBase: D(rBase),
    sostitutivaRinnovi: D(r2(mulPct(rBase, "5"))),
    sostitutivaTurniBase: D(aCapped),
    sostitutivaTurni: D(r2(mulPct(aCapped, "15"))),
    sostitutivaPremiBase: D(pCapped),
    sostitutivaPremi: D(r2(mulPct(pCapped, "1"))),
    sostitutivaRinnoviShare: D(rPlus),
    sostitutivaTurniShare: D(aShare),
    sostitutivaPremiShare: D(pShare),
    period: {
      irpef: per(irpefNetta),
      inpsWorker: per(inpsWorker),
      inpsEmployer: per(inpsEmployer),
      addizionaleRegionale: per(addRegionale),
      addizionaleComunale: per(addComunale),
      trattamentoIntegrativo: per(trattamentoIntegrativo),
      trattamentoSpeciale: per(trattamentoSpeciale),
      somma: per(somma),
      sostitutivaRinnovi: D(sostRinnovi),
      sostitutivaTurni: D(sostTurni),
      sostitutivaPremi: D(sostPremi),
    },
  };
}

/** The 2025 pass: same name and signature as before, reading IT_2025_TABLES. */
export function calculateIt2025(input: It2025Input): It2025Result {
  return calculateItWithTables(input, IT_2025_TABLES);
}

/** The 2026 pass: same engine, reading IT_2026_TABLES. */
export function calculateIt2026(input: It2026Input): It2026Result {
  return calculateItWithTables(input, IT_2026_TABLES);
}

export interface ItStatutoryRates {
  regionalRate: string | null;
  municipalRate: string | null;
  municipalExemption: string | null;
}

/**
 * The DB-free half of the statutory pass: glue from the run context to the
 * pure engine, with tenant rates injected. Unit tests drive this (no
 * Postgres); the production entry below resolves the rates first.
 */
/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are the DPR 600/1973 computation's own
 * (IRPEF, addizionali, INPS shares, trattamento integrativo) — see the
 * module's transcribed basis.
 */
export const IT_FACTOR_LABELS: Readonly<Record<string, string>> = {
  I: "Periodic income this period",
  PI: "Pensionable earnings this period",
  IRPEF: "IRPEF (imposta sul reddito delle persone fisiche)",
  ADDREG: "Addizionale regionale all'IRPEF",
  ADDCOM: "Addizionale comunale all'IRPEF",
  IT_ADDREG_SALDO: "Addizionale regionale a saldo — prior-year assessment installment",
  IT_ADDCOM_SALDO: "Addizionale comunale a saldo — prior-year assessment installment",
  INPS_W: "INPS — contributi IVS a carico del lavoratore",
  INPS_ER: "INPS — contributi IVS a carico del datore",
  TI: "Trattamento integrativo",
  SOMMA: "Somma di cui al comma 4 (L. 207/2024)",
  SPECIALE: "Trattamento integrativo speciale (turismo)",
  CONG_IRPEF_ANNUAL: "Conguaglio — IRPEF annuale ricalcolata (art. 23 DPR 600/1973)",
  CONG_IRPEF_YTD: "Conguaglio — IRPEF trattenuta nell'anno",
  CONG_IRPEF_DELTA: "Conguaglio — differenza IRPEF",
  CONG_ADDREG_ANNUAL: "Conguaglio — addizionale regionale annuale ricalcolata",
  CONG_ADDREG_YTD: "Conguaglio — addizionale regionale trattenuta nell'anno",
  CONG_ADDREG_DELTA: "Conguaglio — differenza addizionale regionale",
  CONG_ADDCOM_ANNUAL: "Conguaglio — addizionale comunale annuale ricalcolata",
  CONG_ADDCOM_YTD: "Conguaglio — addizionale comunale trattenuta nell'anno",
  CONG_ADDCOM_DELTA: "Conguaglio — differenza addizionale comunale",
  CONG_TI_ANNUAL: "Conguaglio — trattamento integrativo annuo verificato",
  CONG_TI_PAID: "Conguaglio — trattamento integrativo erogato nell'anno",
  CONG_SOMMA_ANNUAL: "Conguaglio — somma annua verificata (L. 207/2024)",
  CONG_SOMMA_PAID: "Conguaglio — somma erogata nell'anno",
  IT_SUBST_RINNOVI: "Sostitutiva 5% aumenti rinnovo CCNL — base realizzata (L. 199/2025)",
  IT_SUBST_TURNI: "Sostitutiva 15% indennità notturne/festive/turni — base realizzata (L. 199/2025)",
  IT_SUBST_PREMI: "Sostitutiva 1% premi di risultato — base realizzata (L. 208/2015)",
  CONG_SUBST_RINNOVI_ANNUAL: "Conguaglio — sostitutiva 5% rinnovi annuale ricalcolata",
  CONG_SUBST_RINNOVI_YTD: "Conguaglio — sostitutiva 5% rinnovi trattenuta nell'anno",
  CONG_SUBST_RINNOVI_DELTA: "Conguaglio — differenza sostitutiva 5% rinnovi",
  CONG_SUBST_TURNI_ANNUAL: "Conguaglio — sostitutiva 15% turni annuale ricalcolata",
  CONG_SUBST_TURNI_YTD: "Conguaglio — sostitutiva 15% turni trattenuta nell'anno",
  CONG_SUBST_TURNI_DELTA: "Conguaglio — differenza sostitutiva 15% turni",
  CONG_SUBST_PREMI_ANNUAL: "Conguaglio — sostitutiva 1% premi annuale ricalcolata",
  CONG_SUBST_PREMI_YTD: "Conguaglio — sostitutiva 1% premi trattenuta nell'anno",
  CONG_SUBST_PREMI_DELTA: "Conguaglio — differenza sostitutiva 1% premi",
};

/**
 * Substitute-regime bases already priced this year (committed stubs'
 * IT_SUBST_* factors). Caps bind the annual base, so every priced share
 * needs the realized total; the opening carry-in leg is refused in the
 * adapter (prior-provider substitute bases are unknown).
 */
export async function itSubstituteYtd(input: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  employeePartyId: string;
  taxYear: number;
  payDate: string;
  excludeDocumentId: string;
}): Promise<{ rinovi: string; turni: string; premi: string }> {
  const rows = await input.tx.execute<{ rinovi: string; turni: string; premi: string }>(sql`
    select round(coalesce(sum((s.factors->>'IT_SUBST_RINNOVI')::numeric), 0), 4)::text as rinovi,
           round(coalesce(sum((s.factors->>'IT_SUBST_TURNI')::numeric), 0), 4)::text as turni,
           round(coalesce(sum((s.factors->>'IT_SUBST_PREMI')::numeric), 0), 4)::text as premi
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id
                    and r.document_id = s.pay_run_document_id
                    and r.run_status = 'committed'
     where s.org_id = ${input.orgId}
       and s.employee_party_id = ${input.employeePartyId}
       and s.country = 'IT'
       and s.tax_year = ${input.taxYear}
       and s.pay_date <= ${input.payDate}::date
       and s.pay_run_document_id <> ${input.excludeDocumentId}`);
  return rows.rows[0] ?? { rinovi: "0", turni: "0", premi: "0" };
}

export async function computeItStatutoryWithRates(
  ctx: PayrollStatutoryComputeContext,
  rates: ItStatutoryRates,
): Promise<Record<string, string>> {
  const { taxYear, income, pensionable, nonPeriodic, periodsPerYear, pushStatutory, certificateFor, bool } = ctx;
  // The one-off share already inside the pensionable leg (the engine reports
  // it; unit-constructed contexts omit it and keep legacy math). Annualising
  // the whole leg and adding the one-off again below (pensBase) would count
  // it periodsPerYear + 1 times — a December bonus priced 13 months of INPS,
  // wiping the lavoroNet so IRPEF prices zero.
  const pensionableOneOff = U(ctx.pensionableNonPeriodic ?? "0");
  if (taxYear !== 2025 && taxYear !== 2026) {
    throw new ItPayrollRefusal(
      `IT payroll pack has no transcribed tables for tax year ${taxYear}: 2025 and 2026 are the transcribed `
      + "editions (see engine/src/payroll/it/tax-year-2025.ts and tax-year-2026.ts). Transcribe the year's "
      + "Legge di Bilancio, AdE provvedimenti, and INPS circular into engine/src/payroll/it/rates.ts before "
      + `paying into ${taxYear}.`,
    );
  }
  const cert = certificateFor("it_detrazioni");
  const answers = cert?.answers ?? {};
  if (bool(answers["titolare_pensione"] ?? null)) {
    throw new ItPayrollRefusal(
      `IT ${taxYear} engine refuses pension income: pensionati use the TABELLA 7 detrazioni, not transcribed`,
    );
  }
  const presumed = answers["reddito_complessivo_presunto"] ?? null;
  const countOf = (key: string): number => {
    const raw = answers[key];
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  // 2026 substitute-regime period amounts (certificate-declared; "0" when
  // none). Any positive amount pulls the eligibility inputs, the committed
  // YTD bases for the annual caps, and the pre-adoption carry-in guard.
  const substAmount = (key: string): string => {
    const raw = answers[key];
    return raw == null || raw === "" ? "0" : raw;
  };
  const renewalIncrease = substAmount("importo_aumenti_rinnovo");
  const shiftAllowance = substAmount("importo_indennita_turni");
  const premiRisultato = substAmount("importo_premi_risultato");
  const hasSubst = U(renewalIncrease) > ZERO
    || U(shiftAllowance) > ZERO
    || U(premiRisultato) > ZERO;
  let substYtd = { rinovi: "0", turni: "0", premi: "0" };
  if (hasSubst) {
    const carry = await ctx.tx.execute(sql`
      select 1 from payroll_opening_balances
       where org_id = ${ctx.orgId}
         and employee_party_id = ${ctx.employeePartyId}
         and tax_year = ${taxYear} limit 1`);
    if (carry.rows.length > 0) {
      throw new ItPayrollRefusal(
        `IT ${taxYear} refuses substitute-regime pay with a pre-adoption carry-in: prior-provider `
        + "substitute bases are unknown, so the 1.500/5.000 annual caps cannot bind — settle the "
        + "substitute amounts externally until carry-in support lands.",
      );
    }
    const payDate = ctx.run.pay_date;
    if (payDate == null || payDate === "") {
      throw new ItPayrollRefusal(
        `IT ${taxYear} substitute-regime pay needs the run versement date (run pay_date) to bound the `
        + "annual caps' year-to-date bases.",
      );
    }
    substYtd = await itSubstituteYtd({
      tx: ctx.tx,
      orgId: ctx.orgId,
      employeePartyId: ctx.employeePartyId,
      taxYear,
      payDate,
      excludeDocumentId: ctx.documentId,
    });
  }
  const substIncome = answers["reddito_lavoro_2025"] ?? null;
  const calculate = taxYear === 2026 ? calculateIt2026 : calculateIt2025;
  // L. 207/2024 art. 1 c. 4 selects the somma percentage from full annual
  // employment income, including non-periodic pay; the formula applies that
  // selected percentage to `lavoroNet` inside calculateItWithTables.
  // https://www.gazzettaufficiale.it/eli/id/2024/12/31/24G00229/sg
  const result = calculate({
    hasFamilyCharges: bool(answers["coniuge_a_carico"] ?? null)
      || countOf("figli_a_carico") > 0
      || countOf("altri_familiari_a_carico") > 0,
    annualGrossEmployment: D(U(income) * BigInt(periodsPerYear)),
    sommaBandBase: D(U(income) * BigInt(periodsPerYear) + U(nonPeriodic)),
    // Annualise the recurring leg only; a non-taxable one-off (inside the
    // leg but outside nonPeriodic) still occurs once, so its excess over the
    // taxable one-offs rides as a flat annual add rather than per period.
    annualPensionable: D(
      max0(U(pensionable) - pensionableOneOff) * BigInt(periodsPerYear)
        + max0(pensionableOneOff - U(nonPeriodic)),
    ),
    nonPeriodicAnnual: nonPeriodic,
    presumedTotalIncome: presumed && presumed !== "0" ? presumed : null,
    periodsPerYear,
    regionCode: ctx.region,
    // Tri-state like tempo_determinato below: answered "true"/"false" rides
    // through, anything else is unattributed (regione 04 then refuses).
    domicileBolzano: answers["domicilio_bolzano"] === "true"
      ? true
      : answers["domicilio_bolzano"] === "false"
        ? false
        : null,
    comuneCode: (answers["domicilio_comune"] ?? null) as string | null,
    regionalRate: rates.regionalRate,
    municipalSurtax: rates.municipalRate == null
      ? null
      : { rate: rates.municipalRate, exemption: rates.municipalExemption },
    hasDetrazioniDeclaration: cert !== null,
    isFixedTerm: answers["tempo_determinato"] === "true"
      ? true
      : answers["tempo_determinato"] === "false"
        ? false
        : null,
    renewalIncrease: substAmount("importo_aumenti_rinnovo"),
    shiftAllowance: substAmount("importo_indennita_turni"),
    premiRisultato: substAmount("importo_premi_risultato"),
    renewalIncreaseYtd: substYtd.rinovi,
    shiftAllowanceYtd: substYtd.turni,
    premiRisultatoYtd: substYtd.premi,
    priorYearEmploymentIncome: substIncome,
    premiRisultatoEligible: answers["premi_risultato_ammissibili"] === "true"
      ? true
      : answers["premi_risultato_ammissibili"] === "false"
        ? false
        : null,
    isPost1995: answers["anzianita_post_1995"] == null || answers["anzianita_post_1995"] === ""
      ? undefined
      : bool(answers["anzianita_post_1995"]),
    // Tourism speciale claim (IT-TOURISM-2026-IMPL): the worker's request
    // with autocertified facts rides it_turismo_speciale; absent, the
    // engine prices ordinary (no claim, no credit, no refusal).
    tourismSpecialPay2026: (() => {
      const turismo = certificateFor("it_turismo_speciale");
      if (turismo == null) return undefined;
      const t = turismo.answers ?? {};
      return {
        amount: t["importo_qualificante"] ?? "",
        sector: null,
        workDate: t["data_prestazione"] ?? null,
        eligibleSector: t["settore_ammesso"] === "true" ? true : t["settore_ammesso"] === "false" ? false : undefined,
        workerRequested: t["richiesta"] === "true" ? true : t["richiesta"] === "false" ? false : undefined,
        priorYearIncome: t["reddito_2025"] ?? null,
      };
    })(),
  });
  // The period figures below are 1/12 advances of the current-year liability
  // (the previsionale the December conguaglio trues up — see ./conguaglio.ts).
  // The statutory saldo schedule rides beside them, priced by the production
  // entry after this core returns: the prior-year assessment in up to 11
  // regionale instalments and up to 9 comunale instalments from March, from
  // the assessed-saldo channel (see ./surtax-balances.ts), which refuses by
  // name when neither source exists. Refusals that CAN fire stay in the core:
  // unconfigured regional/municipal rates and an unknown or malformed
  // domicilio comune refuse by name there, before this point.
  // https://www.inps.it/it/it/dettaglio-approfondimento.schede-informative.53546.pensioni-addizionali-irpef-regionali-e-comunali.html
  pushStatutory("income_tax", "deduction", "IRPEF", result.period.irpef, 110);
  pushStatutory("regional_surtax", "deduction", "Addizionale regionale all'IRPEF", result.period.addizionaleRegionale, 115);
  pushStatutory("municipal_surtax", "deduction", "Addizionale comunale all'IRPEF", result.period.addizionaleComunale, 120);
  pushStatutory("inps", "deduction", "INPS — contributi IVS a carico del lavoratore", result.period.inpsWorker, 130);
  pushStatutory("sostitutiva_rinnovi", "deduction", "Sostitutiva 5% aumenti rinnovo CCNL", result.period.sostitutivaRinnovi, 111);
  pushStatutory("sostitutiva_turni", "deduction", "Sostitutiva 15% indennità notturne/festive/turni", result.period.sostitutivaTurni, 112);
  pushStatutory("sostitutiva_premi", "deduction", "Sostitutiva 1% premi di risultato", result.period.sostitutivaPremi, 113);
  pushStatutory("ti_payout", "credit", "Trattamento integrativo", result.period.trattamentoIntegrativo, 140);
  pushStatutory("somma_payout", "credit", "Somma di cui al comma 4 (L. 207/2024)", result.period.somma, 145);
  if (result.trattamentoSpeciale !== "0.0000") {
    pushStatutory("speciale_payout", "credit", "Trattamento integrativo speciale (turismo)", result.period.trattamentoSpeciale, 147);
  }
  pushStatutory("inps", "employer_contribution", "INPS — contributi IVS a carico del datore", result.period.inpsEmployer, 230);
  return {
    I: income,
    PI: pensionable,
    IT_SUBST_RINNOVI: result.sostitutivaRinnoviShare,
    IT_SUBST_TURNI: result.sostitutivaTurniShare,
    IT_SUBST_PREMI: result.sostitutivaPremiShare,
    IRPEF: result.period.irpef,
    ADDREG: result.period.addizionaleRegionale,
    ADDCOM: result.period.addizionaleComunale,
    INPS_W: result.period.inpsWorker,
    INPS_ER: result.period.inpsEmployer,
    TI: result.period.trattamentoIntegrativo,
    SOMMA: result.period.somma,
    SPECIALE: result.period.trattamentoSpeciale,
  };
}

/**
 * Phase 9 — IT pack statutory pass for 2025 and 2026. Refuses every other
 * year. The production entry only: after the DB-free core prices the
 * current-year advances, the assessed-saldo channel prices the prior-year
 * balance installments (see ./surtax-balances.ts) and refuses by name when
 * neither source exists. Unit tests drive the core with no database and see
 * advances only.
 */
export async function computeItStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  if (ctx.taxYear !== 2025 && ctx.taxYear !== 2026) {
    return computeItStatutoryWithRates(ctx, {
      regionalRate: null,
      municipalRate: null,
      municipalExemption: null,
    });
  }
  const resolution = await resolveStatutoryRates(ctx.orgId, IT_PACK_RATES, ctx.taxYear, ctx.run.pay_date);
  const region = ctx.region;
  const cert = ctx.certificateFor("it_detrazioni");
  const comune = cert?.answers["domicilio_comune"] ?? null;
  const regionale = resolution.values("it_addizionale_regionale", { region });
  const comunale = comune
    ? resolution.values("it_addizionale_comunale", { region, subRegion: comune })
    : null;
  const factors = await computeItStatutoryWithRates(ctx, {
    regionalRate: regionale?.rate ?? null,
    municipalRate: comunale?.rate ?? null,
    municipalExemption: comunale?.exemption ?? null,
  });
  const payDate = ctx.run.pay_date;
  if (payDate == null || payDate === "") {
    throw new ItPayrollRefusal(
      `IT ${ctx.taxYear} saldo installments accrue against the run versement date (run pay_date), `
      + "which the run did not resolve — engine defect",
    );
  }
  return {
    ...factors,
    ...(await pushItSurtaxSaldoInstallments({
      tx: ctx.tx,
      orgId: ctx.orgId,
      employeePartyId: ctx.employeePartyId,
      documentId: ctx.documentId,
      taxYear: ctx.taxYear,
      payDate,
      pushStatutory: ctx.pushStatutory,
    })),
  };
}
