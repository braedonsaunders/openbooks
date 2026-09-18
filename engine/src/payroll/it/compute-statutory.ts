/**
 * The IT pack's statutory pass for tax year 2025 (anno d'imposta 2025).
 *
 * Method (engine-stated where the agency is silent): annualise the period's
 * pay (gross x periodsPerYear, one-off non-periodic added once), compute the
 * ANNUAL liability — IRPEF scaglioni on the imponibile, art. 13 detrazione
 * lavoro dipendente plus the +65 euro c. 2 increase, the L. 207/2024 c. 6
 * ulteriore detrazione, INPS IVS 9,19/23,81 with prima fascia and post-1995
 * massimale, the declared-rate addizionali, the trattamento integrativo and
 * the c. 4 somma payouts — then divide back to the period, rounded half-up
 * to the cent per the CU 2026 istruzioni (quoted in tax-year-2025.ts). The
 * division rounding is the engine's own rule; the agency states per-amount
 * cent rounding only.
 *
 * What the engine assumes (stated, not hidden): a full-year worker at this
 * pay (no presumption data beyond the dichiarazione's reddito presunto,
 * which raises the complessivo thresholds when higher); ctx.region is read
 * as the fiscal domicile region (surcharges follow the domicile, never the
 * workplace — withholding.ts); the c. 4 somma band is read off the
 * theoretical gross annual while the percentage applies to the net lavoro
 * base (Circ. 4/E Esempio 3). Multi-employer conguaglio, monthly
 * mensilizzazione of the 1% additional, acconto/saldo instalments, and the
 * 10-rate recovery of indebiti are year-end/timing mechanics the per-period
 * engine does not model — refused by name (IT_REFUSED_2025).
 *
 * Deliberately NOT called: `assertRegionSupported`. No region publishes its
 * own tables, so `regions.supported` is correctly [] (finding F-fr-001)
 * while the pass runs for any known ISTAT region once its surtax rates are
 * declared. An unconfigured rate is a refusal naming the scope point — a
 * pack that computes the surtax from a guessed rate is wrong money.
 *
 * Money: bigint units (1e4) throughout, halves away from zero, via the
 * repo's money.ts — the same discipline as canada/decimal.ts. Ratios are
 * TRUNCATED to 4 decimals per 730/2026 TABELLA 6 note (2).
 */
import { fromUnits, roundDiv, toUnits } from "../../money.ts";
import { PayrollError } from "../../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import { IT_REGION_CODES } from "./regions.ts";
import {
  IT_2025_DETRAZIONE_C2,
  IT_2025_DETRAZIONE_LAVORO,
  IT_2025_INPS_IVS,
  IT_2025_IRPEF_BANDS,
  IT_2025_MASSIMALE_POST1995,
  IT_2025_PRIMA_FASCIA,
  IT_2025_RATIO_DECIMALS,
  IT_2025_SOMMA,
  IT_2025_TRATTAMENTO_INTEGRATIVO,
  IT_2025_ULTERIORE_DETRAZIONE,
} from "./tax-year-2025.ts";

export class ItPayrollRefusal extends PayrollError {}

const U = (s: string | number): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);
const CENT = 100n;
const ZERO = 0n;

/** Round units half-up to the cent (CU 2026 istruzioni rule). */
function r2(u: bigint): bigint {
  return roundDiv(u, CENT) * CENT;
}

/** amount x fraction, both exact (fraction as decimal string, e.g. "0.23"). */
function mulFrac(u: bigint, frac: string): bigint {
  return (u * U(frac)) / 10_000n;
}

/** amount x percent-number (e.g. "0.8" for 0,8%), exact. */
function mulPct(u: bigint, pct: string): bigint {
  return (u * U(pct)) / (100n * 10_000n);
}

const max0 = (u: bigint): bigint => (u < ZERO ? ZERO : u);
const bmin = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * Truncate a non-negative ratio num/den to 4 decimals (730/2026 TABELLA 6
 * note 2: "lo stesso si assume nelle prime 4 cifre decimali").
 */
function truncRatio4(num: bigint, den: bigint): bigint {
  if (num <= ZERO) return ZERO;
  if (den <= ZERO) throw new Error("ratio denominator must be greater than zero");
  return (num * 10n ** BigInt(IT_2025_RATIO_DECIMALS)) / den;
}

function marginalTax(baseUnits: bigint): bigint {
  let tax = ZERO;
  let lower = ZERO;
  for (const band of IT_2025_IRPEF_BANDS) {
    if (baseUnits <= lower) break;
    const upper = band.upTo === null ? baseUnits : bmin(baseUnits, U(band.upTo));
    tax += mulFrac(upper - lower, band.rate);
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
  /** Domicile comune (codice catastale); null refuses the comunale. */
  comuneCode: string | null;
  /** Declared regionale rate; null refuses (never guessed). */
  regionalRate: string | null;
  /** Declared comunale rate/exemption; null refuses (never guessed). */
  municipalSurtax: It2025SurtaxInput | null;
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
   * Any art. 12 family charge (coniuge/figli/altri a carico). Decides the
   * 15.001–28.000 TI band: without family charges the verifica provably
   * fails there (detrazione lavoro < imposta lorda on the whole band), so
   * TI is 0; with family charges the verifica needs the untranscribed
   * art. 12 detrazioni and the engine refuses by name.
   */
  hasFamilyCharges?: boolean;
  isFixedTerm?: boolean;
  /** Art. 49 c. 2 lett. a) pension income: refused (TABELLA 7). */
  isPensioner?: boolean;
  /** Post-1995 seniority: the 120.607 massimale applies. */
  isPost1995?: boolean;
}

export interface It2025Result {
  /** Annual figures, 4dp strings. */
  redditoComplessivo: string;
  imponibileIrpef: string;
  irpefLorda: string;
  detrazioneLavoro: string;
  ulterioreDetrazione: string;
  irpefNetta: string;
  trattamentoIntegrativo: string;
  somma: string;
  inpsWorker: string;
  inpsEmployer: string;
  addizionaleRegionale: string;
  addizionaleComunale: string;
  /** Period figures (annual / periodsPerYear, half-up cent). */
  period: {
    irpef: string;
    inpsWorker: string;
    inpsEmployer: string;
    addizionaleRegionale: string;
    addizionaleComunale: string;
    trattamentoIntegrativo: string;
    somma: string;
  };
}

function refuse(message: string): never {
  throw new ItPayrollRefusal(message);
}

function needNonNegative(value: string, what: string): bigint {
  const u = U(value);
  if (u < ZERO) refuse(`IT 2025 engine needs non-negative ${what}, got ${value}`);
  return u;
}

export function calculateIt2025(input: It2025Input): It2025Result {
  if (input.isPensioner) {
    refuse(
      "IT 2025 engine refuses pension income (art. 49 c. 2 lett. a)): pensionati use the "
      + "TABELLA 7 detrazioni, not transcribed — see IT_REFUSED_2025",
    );
  }
  if (!Number.isInteger(input.periodsPerYear) || input.periodsPerYear <= 0) {
    refuse(`IT 2025 annualisation needs a positive integer periodsPerYear, got ${input.periodsPerYear}`);
  }
  if (!IT_REGION_CODES.includes(input.regionCode)) {
    refuse(
      `unknown IT regione "${input.regionCode || "(unset)"}": the IT payroll pack knows `
      + `${IT_REGION_CODES.join(", ")}`,
    );
  }
  const gross = needNonNegative(input.annualGrossEmployment, "annualGrossEmployment");
  const oneOff = needNonNegative(input.nonPeriodicAnnual ?? "0", "nonPeriodicAnnual");
  const pensBase = needNonNegative(input.annualPensionable, "annualPensionable") + oneOff;

  // INPS IVS on the pensionable base, with prima fascia and massimale.
  const cap = input.isPost1995 ? U(IT_2025_MASSIMALE_POST1995) : null;
  const ivsBase = cap === null ? pensBase : bmin(pensBase, cap);
  const inpsWorker = r2(mulFrac(ivsBase, IT_2025_INPS_IVS.worker))
    + r2(mulFrac(max0(bmin(pensBase, cap ?? pensBase) - U(IT_2025_PRIMA_FASCIA.annual)), IT_2025_PRIMA_FASCIA.additionalWorker));
  const inpsEmployer = r2(mulFrac(ivsBase, IT_2025_INPS_IVS.employer));

  // Reddito di lavoro netto (category level, contributions already out) and
  // the complessivo the thresholds read (presunto raises, never lowers).
  const lavoroNet = max0(gross + oneOff - inpsWorker);
  const presunto = input.presumedTotalIncome == null || input.presumedTotalIncome === ""
    ? ZERO
    : needNonNegative(input.presumedTotalIncome, "presumedTotalIncome");
  const R = presunto > lavoroNet ? presunto : lavoroNet;

  const imponibile = R;
  const irpefLorda = r2(marginalTax(imponibile));

  // Art. 13 detrazione lavoro dipendente (declaration-gated) with the
  // c. 2 +65 euro increase for 25.001–35.000.
  const L = IT_2025_DETRAZIONE_LAVORO;
  let detC1 = ZERO;
  if (R <= U(L.bandA_cap)) {
    detC1 = U(L.bandA_amount);
    const floor = U(input.isFixedTerm ? L.floorFixedTerm : L.floor);
    if (detC1 < floor) detC1 = floor;
  } else if (R <= U(L.bandB_cap)) {
    detC1 = U(L.bandB_base)
      + (U(L.bandB_factor) * truncRatio4(U(L.bandB_cap) - R, U(L.bandB_span))) / 10_000n;
  } else if (R <= U(L.bandC_cap)) {
    detC1 = (U(L.bandC_base) * truncRatio4(U(L.bandC_cap) - R, U(L.bandC_span))) / 10_000n;
  }
  detC1 = r2(detC1);
  const C2 = IT_2025_DETRAZIONE_C2;
  const detC2 = R >= U(C2.fromExclusive) && R <= U(C2.toInclusive) ? U(C2.amount) : ZERO;
  const detLavoro = input.hasDetrazioniDeclaration ? detC1 + detC2 : ZERO;

  // L. 207/2024 c. 6 ulteriore detrazione (automatic per Circ. 4/E c. 7).
  const UD = IT_2025_ULTERIORE_DETRAZIONE;
  let ulteriore = ZERO;
  if (R > U(UD.bandA_fromExclusive) && R <= U(UD.bandA_toInclusive)) {
    ulteriore = U(UD.amount);
  } else if (R > U(UD.bandA_toInclusive) && R < U(UD.bandB_toExclusive)) {
    ulteriore = (U(UD.amount) * truncRatio4(U(UD.bandB_toExclusive) - R, U(UD.bandB_span))) / 10_000n;
  }
  ulteriore = r2(ulteriore);

  // Capienza: detrazioni reduce the imposta lorda, never below zero (AdE:
  // "Deductions are generally applied up to the amount of the tax due").
  const detLavoroCapped = bmin(detLavoro, irpefLorda);
  const ulterioreCapped = bmin(ulteriore, irpefLorda - detLavoroCapped);
  const irpefNetta = irpefLorda - detLavoroCapped - ulterioreCapped;

  // Trattamento integrativo: full 1.200 only at R ≤ 15.000 with capienza
  // over the c. 1 detrazione minus 75 euro; the 15.001–28.000 verifica
  // needs art. 12/15 detrazioni the pack does not carry — refused by name.
  const TI = IT_2025_TRATTAMENTO_INTEGRATIVO;
  let trattamentoIntegrativo = ZERO;
  if (R <= U(TI.incomeCap)) {
    if (irpefLorda > detC1 - U(TI.detrazioneReduction)) {
      trattamentoIntegrativo = U(TI.amount);
    }
  } else if (R <= U(L.bandB_cap)) {
    if (input.hasFamilyCharges) {
      refuse(
        "IT 2025 trattamento integrativo for reddito complessivo 15.001–28.000 with family charges "
        + "is refused by name: the verifica (detrazioni art. 12/15 > imposta lorda) needs the "
        + "untranscribed art. 12 detrazioni — see IT_REFUSED_2025",
      );
    }
    // No-family case: detrazione lavoro alone stays below the imposta lorda
    // on the whole (15.000, 28.000] band (max ~3.100 at the left edge vs a
    // lorda that starts at ~3.133 and rises), so the verifica fails and TI
    // is 0 — computed, not refused.
  }

  // L. 207/2024 c. 4 somma (automatic): band off the theoretical annual,
  // percentage on the actual imponibile lavoro base (Circ. 4/E Es. 3).
  const S = IT_2025_SOMMA;
  let somma = ZERO;
  if (R <= U(S.incomeCap)) {
    const bandBase = input.sommaBandBase == null || input.sommaBandBase === ""
      ? gross
      : needNonNegative(input.sommaBandBase, "sommaBandBase");
    const band = S.bands.find((b) => b.upTo === null || bandBase <= U(b.upTo));
    if (!band) refuse("IT 2025 somma band resolution failed — internal error, not a table gap");
    somma = r2(mulFrac(lavoroNet, band.rate));
  }

  // Addizionali from declared rates on the IRPEF imponibile. No configured
  // rate is a refusal naming the scope point — never a guessed rate, never
  // a lookup by address.
  if (input.regionalRate == null || input.regionalRate === "") {
    refuse(
      `no it_addizionale_regionale rate is configured for regione ${input.regionCode} in 2025 — `
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
  if (input.municipalSurtax == null || input.municipalSurtax.rate === "") {
    refuse(
      `no it_addizionale_comunale rate is configured for comune ${input.comuneCode} (regione `
      + `${input.regionCode}) in 2025 — the domicile comune's deliberated rate must be entered`,
    );
  }
  const addRegionale = r2(mulPct(imponibile, input.regionalRate));
  const exemption = input.municipalSurtax.exemption == null || input.municipalSurtax.exemption === ""
    ? null
    : needNonNegative(input.municipalSurtax.exemption, "municipalExemption");
  const addComunale = exemption !== null && imponibile <= exemption
    ? ZERO
    : r2(mulPct(imponibile, input.municipalSurtax.rate));

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
    somma: D(somma),
    inpsWorker: D(inpsWorker),
    inpsEmployer: D(inpsEmployer),
    addizionaleRegionale: D(addRegionale),
    addizionaleComunale: D(addComunale),
    period: {
      irpef: per(irpefNetta),
      inpsWorker: per(inpsWorker),
      inpsEmployer: per(inpsEmployer),
      addizionaleRegionale: per(addRegionale),
      addizionaleComunale: per(addComunale),
      trattamentoIntegrativo: per(trattamentoIntegrativo),
      somma: per(somma),
    },
  };
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
export async function computeItStatutoryWithRates(
  ctx: PayrollStatutoryComputeContext,
  rates: ItStatutoryRates,
): Promise<Record<string, string>> {
  const { taxYear, income, pensionable, nonPeriodic, periodsPerYear, pushStatutory, certificateFor, bool } = ctx;
  if (taxYear !== 2025) {
    throw new ItPayrollRefusal(
      `IT payroll pack has no transcribed tables for tax year ${taxYear}: 2025 is the only transcribed `
      + "edition (see engine/src/payroll/it/tax-year-2025.ts); 2026 is refused by name (L. 199/2025 rewrote "
      + "the second IRPEF bracket and the AdE rates page is internally inconsistent).",
    );
  }
  const cert = certificateFor("it_detrazioni");
  const answers = cert?.answers ?? {};
  if (bool(answers["titolare_pensione"] ?? null)) {
    throw new ItPayrollRefusal(
      "IT 2025 engine refuses pension income: pensionati use the TABELLA 7 detrazioni, not transcribed",
    );
  }
  const presumed = answers["reddito_complessivo_presunto"] ?? null;
  const countOf = (key: string): number => {
    const raw = answers[key];
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const result = calculateIt2025({
    hasFamilyCharges: bool(answers["coniuge_a_carico"] ?? null)
      || countOf("figli_a_carico") > 0
      || countOf("altri_familiari_a_carico") > 0,
    annualGrossEmployment: D(U(income) * BigInt(periodsPerYear)),
    annualPensionable: D(U(pensionable) * BigInt(periodsPerYear)),
    nonPeriodicAnnual: nonPeriodic,
    presumedTotalIncome: presumed && presumed !== "0" ? presumed : null,
    periodsPerYear,
    regionCode: ctx.region,
    comuneCode: (answers["domicilio_comune"] ?? null) as string | null,
    regionalRate: rates.regionalRate,
    municipalSurtax: rates.municipalRate == null
      ? null
      : { rate: rates.municipalRate, exemption: rates.municipalExemption },
    hasDetrazioniDeclaration: cert !== null,
    isFixedTerm: bool(answers["tempo_determinato"] ?? null),
    isPost1995: bool(answers["anzianita_post_1995"] ?? null),
  });
  pushStatutory("income_tax", "deduction", "IRPEF", result.period.irpef, 110);
  pushStatutory("regional_surtax", "deduction", "Addizionale regionale all'IRPEF", result.period.addizionaleRegionale, 115);
  pushStatutory("municipal_surtax", "deduction", "Addizionale comunale all'IRPEF", result.period.addizionaleComunale, 120);
  pushStatutory("inps", "deduction", "INPS — contributi IVS a carico del lavoratore", result.period.inpsWorker, 130);
  pushStatutory("inps", "employer_contribution", "INPS — contributi IVS a carico del datore", result.period.inpsEmployer, 230);
  // TI and somma are payouts, not deductions: no deduction/employer_contribution
  // line can carry them without misstating the stub, so they travel as factors
  // until the generic layer offers a credit channel (proposed to Orchestrate).
  return {
    I: income,
    PI: pensionable,
    IRPEF: result.period.irpef,
    ADDREG: result.period.addizionaleRegionale,
    ADDCOM: result.period.addizionaleComunale,
    INPS_W: result.period.inpsWorker,
    INPS_ER: result.period.inpsEmployer,
    TI: result.period.trattamentoIntegrativo,
    SOMMA: result.period.somma,
  };
}

/** Phase 9 — IT pack statutory pass for 2025. Refuses every other year. */
export async function computeItStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  if (ctx.taxYear !== 2025) {
    return computeItStatutoryWithRates(ctx, {
      regionalRate: null,
      municipalRate: null,
      municipalExemption: null,
    });
  }
  const resolution = await resolveStatutoryRates(ctx.orgId, "IT", ctx.taxYear);
  const region = ctx.region;
  const cert = ctx.certificateFor("it_detrazioni");
  const comune = cert?.answers["domicilio_comune"] ?? null;
  const regionale = resolution.values("it_addizionale_regionale", { region });
  const comunale = comune
    ? resolution.values("it_addizionale_comunale", { region, subRegion: comune })
    : null;
  return computeItStatutoryWithRates(ctx, {
    regionalRate: regionale?.rate ?? null,
    municipalRate: comunale?.rate ?? null,
    municipalExemption: comunale?.exemption ?? null,
  });
}
