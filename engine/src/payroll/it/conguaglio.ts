/**
 * Italy's conguaglio di fine anno — the art. 23 c. 3 DPR 600/1973 annual
 * settlement, declared against the shared pack capability
 * (engine/src/payroll/annual-settlement.ts).
 *
 * THE LAW. "I soggetti indicati nel comma 1 devono effettuare, entro il 28
 * febbraio dell'anno successivo e, in caso di cessazione del rapporto di
 * lavoro, alla data di cessazione, il conguaglio tra le ritenute operate
 * sulle somme e i valori di cui alle lettere a) e b) del comma 2, e
 * l'imposta dovuta sull'ammontare complessivo degli emolumenti stessi,
 * tenendo conto delle detrazioni eventualmente spettanti a norma degli
 * articoli 12 e 13 del testo unico delle imposte sui redditi" — art. 23 c. 3
 * DPR 29 settembre 1973, n. 600 (MEF Documentazione Tributaria). The December
 * final run settles inside the 28 February deadline; a worker who left
 * mid-year is settled alla data di cessazione, outside this run — leavers
 * are simply not employees of the December payroll, and multi-employer /
 * prior-CU income stays refused (IT_REFUSED_2025/2026: Circ. 4/E verifiche
 * on previsionale + worker-delivered CUs, which the engine does not carry).
 *
 * THE SHAPE. `mode: "adjustment_line"`: one extra line per component on an
 * otherwise normal final run. For full-year level pay the annual
 * recomputation agrees with the monthly annualisation arithmetically — the
 * legitimate zero, which pushes nothing. What remains is cent-level division
 * dust (the monthly divide-by-periods rounding is the engine's own rule; the
 * agency states per-amount cent rounding only), and dust IS settled: art. 23
 * c. 3 settles operate vs dovuta to the cent, so punto 21 keeps equalling
 * money actually moved.
 *
 * THE ANNUAL RECOMPUTATION. The same `calculateItWithTables` the monthly
 * pass uses — scaglioni on the year's total (art. 11 TUIR; 2026 second
 * bracket 33% per L. 199/2025 art. 1 c. 3), detrazione lavoro re-phased on
 * the annual reddito (art. 13 c. 1 TUIR; ratios truncated to 4 decimals per
 * 730/2026 TABELLA 6 note 2), the +65 euro c. 2 increase (R > 25.000–35.000,
 * the L. 207/2024 c. 6 ulteriore detrazione (whose spettanza c. 7 says to
 * verify in sede di conguaglio), INPS IVS for the lavoro-netto base, the
 * tenant-declared addizionali (D.Lgs. 446/1997 regionale; D.Lgs. 360/1998
 * comunale — the annual liability recomputed here; the prior-year saldo the
 * year withheld in instalments nets out of the paid side so the delta
 * settles the combined position, see itAnnualSettlement below; the 30%
 * comunale acconto keeps its own unmodelled schedule per the refused lists),
 * the trattamento
 * integrativo (D.L. 3/2020 art. 1 c. 1) and the c. 4 somma (L. 207/2024
 * art. 1 c. 4–5) for the credit guard below. Fed with actuals
 * (periodsPerYear 1: the period figures ARE the annual figures) instead of
 * the monthly annualisation. Refusal parity with the monthly engine is
 * structural, not asserted: same function, same declaration answers, same
 * tenant rates — pensionati, unknown regions, bad catastale codes, and
 * unconfigured rates refuse here exactly as they refuse there.
 *
 * PRIORS CONVENTIONS (v1 settlement priors carry committed-stub totals).
 * `ytdGross` is the all-in committed taxable gross for the tax year —
 * periodic pay plus one-off non-periodic erogazioni, the same money the
 * monthly `income + nonPeriodic` prices — so `nonPeriodicAnnual` is "0" and
 * nothing double-counts. The priors carry a single gross, so the INPS base
 * is priced off it too: the same basis the monthly pass annualises from the
 * final run's lines. Absent per-key totals read as "0": no committed line
 * under a key means no money moved under it — the committed-stub doctrine
 * the contract states. Deltas push exact to the cent through the contract's
 * sign-refusing push (refunds positive credits, collections positive
 * deductions, per the money rule the contract inherits from the trattamento
 * integrativo rail).
 *
 * WHAT IS NOT SETTLED HERE. INPS differences are not art. 23 ritenute and
 * ride the contributory channel, not this settlement. Trattamento
 * integrativo and somma differences are VERIFIED but not pushed: their
 * correct year-end figure needs the periodo-di-lavoro rapportatura (D.L.
 * 3/2020 art. 1 c. 1; L. 207/2024 art. 1 c. 5) the v1 priors do not carry
 * (the recomputation rapporta only when taxYearWorkDays is supplied, and
 * the priors still carry no days-worked), and indebiti oltre 60 euro recover in dieci rate per
 * L. 207/2024 art. 1 c. 7 — a timing no in-product mechanism prices (see
 * IT_REFUSED_2025/2026). So when the annual credit figure differs from the
 * paid total beyond rounding dust, the settlement REFUSES the whole
 * employee — all or nothing, never a partial slip — naming both figures,
 * the rapportatura rule, the ten-rate rule, and the manual remedy (verify
 * the rapportata spettanza and settle the residual through a pay-run
 * adjustment, engine/src/payroll/run-adjustments.ts; the IRPEF/addizionali
 * conguaglio for that employee is left unsettled by this run). Within dust
 * (±0,10 euro: twelve monthly half-cent roundings plus the annual half-cent
 * = 0,065 bound, so 0,10 proves no spettanza shift, only rounding), the
 * credits are taken as verified and push nothing. A missing it_detrazioni
 * declaration is NOT a refusal: the monthly engine computes without
 * detrazioni then (art. 23: detrazioni only on declaration), and the annual
 * recomputation does the same — parity, stated. The comune-less sub-case
 * still refuses in-engine by name, as monthly.
 */
import { cmp, fromUnits, neg, toUnits } from "../../money/money.ts";
import type {
  PayrollAnnualSettlement,
  PayrollAnnualSettlementContext,
} from "../annual-settlement.ts";
import { createSettlementPush } from "../annual-settlement.ts";
import type { PushStatutoryFn } from "../statutory-context.ts";
import {
  calculateItWithTables,
  IT_2025_TABLES,
  IT_2026_TABLES,
  ItPayrollRefusal,
  mulPct,
  r2,
  type ItYearTables,
} from "./compute-statutory.ts";
import { IT_PACK_RATES } from "./rates.ts";
import { resolveItSurtaxAssessed } from "./surtax-balances.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";

export { ItPayrollRefusal };

/** The agency's own name for the settlement. */
export const IT_CONGUAGLIO_LABEL = "Conguaglio di fine anno";

/** Every rule the settlement prices, to the document and section. */
export const IT_CONGUAGLIO_CITATION =
  "art. 23 c. 3 DPR 29 settembre 1973, n. 600 (conguaglio entro il 28 febbraio "
  + "dell'anno successivo; alla data di cessazione in caso di cessazione del rapporto); "
  + "art. 11 TUIR scaglioni; artt. 12–13 TUIR detrazioni; L. 207/2024 art. 1 c. 4–7 "
  + "(somma, ulteriore detrazione, verifica in sede di conguaglio, recupero indebiti in dieci rate); "
  + "D.L. 3/2020 art. 1 trattamento integrativo; D.Lgs. 446/1997 addizionale regionale; "
  + "D.Lgs. 360/1998 addizionale comunale";

/** Tenant-declared rate slots the settlement prices through — configuration. */
export const IT_CONGUAGLIO_TENANT_RATES = [
  "it_addizionale_regionale",
  "it_addizionale_comunale",
] as const;

/**
 * Credit-guard dust tolerance. Twelve monthly half-cent roundings (0,06)
 * plus the annual half-cent (0,005) bound the rounding drift at 0,065, so a
 * TI/somma gap within 0,10 euro proves rounding, never a spettanza shift.
 */
export const IT_CONGUAGLIO_CREDIT_DUST_TOLERANCE = "0.10";

/** Trace-factor keys the settlement returns (labelled in IT_FACTOR_LABELS). */
export const IT_CONGUAGLIO_FACTOR_KEYS = [
  "CONG_IRPEF_ANNUAL",
  "CONG_IRPEF_YTD",
  "CONG_IRPEF_DELTA",
  "CONG_ADDREG_ANNUAL",
  "CONG_ADDREG_YTD",
  "CONG_ADDREG_DELTA",
  "CONG_ADDCOM_ANNUAL",
  "CONG_ADDCOM_YTD",
  "CONG_ADDCOM_DELTA",
  "CONG_TI_ANNUAL",
  "CONG_TI_PAID",
  "CONG_SOMMA_ANNUAL",
  "CONG_SOMMA_PAID",
  "CONG_SUBST_RINNOVI_ANNUAL",
  "CONG_SUBST_RINNOVI_YTD",
  "CONG_SUBST_RINNOVI_DELTA",
  "CONG_SUBST_TURNI_ANNUAL",
  "CONG_SUBST_TURNI_YTD",
  "CONG_SUBST_TURNI_DELTA",
  "CONG_SUBST_PREMI_ANNUAL",
  "CONG_SUBST_PREMI_YTD",
  "CONG_SUBST_PREMI_DELTA",
] as const;

export interface ItConguaglioDeclaration {
  /** it_detrazioni on file: detrazioni apply only on declaration (art. 23). */
  hasDetrazioniDeclaration: boolean;
  /** Any art. 12 family charge: gates the 15.001–28.000 TI band, as monthly. */
  hasFamilyCharges: boolean;
  /** Fixed-term contract: art. 13 c. 1 floor 1.380 instead of 690. */
  isFixedTerm: boolean | null;
  /** Post-1995 seniority: the year's massimale applies; absent is unknown. */
  isPost1995?: boolean;
  /** Art. 49 c. 2 lett. a) pension income: refused, as monthly. */
  isPensioner?: boolean;
  /** Reddito complessivo presunto from the declaration, when declared. */
  presumedTotalIncome: string | null;
  /**
   * Substitute-regime period amounts from the declaration (final run's
   * amounts; annual totals add the committed YTD bases below). Ceilings and
   * the premi eligibility ride the same inputs as monthly.
   */
  renewalIncrease?: string;
  shiftAllowance?: string;
  premiRisultato?: string;
  priorYearEmploymentIncome?: string | null;
  premiRisultatoEligible?: boolean | null;
  /** Domicile comune (codice catastale); null refuses the comunale, as monthly. */
  comuneCode: string | null;
  /**
   * Domiciled in the autonomous province of Bolzano; unattributed "04"
   * refuses, as monthly. Optional: an absent key reads exactly like an
   * explicit null (every reader tests `!== true` / `!== false`), so fixture
   * declarations need not restate the unattributed default.
   */
  domicileBolzano?: boolean | null;
}

export interface ItConguaglioRates {
  /** Domicile region's deliberated rate; null refuses, never guessed. */
  regionalRate: string | null;
  /** Domicile comune's deliberated rate; null refuses, never guessed. */
  municipalRate: string | null;
  /** Comune's deliberated exemption threshold, when deliberated. */
  municipalExemption: string | null;
}

export interface ItConguaglioInput {
  taxYear: number;
  /** Domicile regione (ISTAT code): domicile selects, never the workplace. */
  regionCode: string;
  /**
   * Days of employment in the tax year (I6-payroll-19): carried into the
   * annual recomputation so detrazioni rapportano al periodo di lavoro.
   * Absent keeps the full-year assumption the v1 priors always carried.
   */
  taxYearWorkDays?: number | null;
  /** All-in committed taxable gross for the tax year, current run included. */
  ytdGross: string;
  /** Committed stub sums by systemKey; absent keys read as "0". */
  ytdBySystemKey: Readonly<Record<string, string>>;
  declaration: ItConguaglioDeclaration;
  rates: ItConguaglioRates;
}

function tablesFor(taxYear: number): ItYearTables {
  if (taxYear === 2025) return IT_2025_TABLES;
  if (taxYear === 2026) return IT_2026_TABLES;
  throw new ItPayrollRefusal(
    `IT conguaglio has no transcribed tables for tax year ${taxYear}: 2025 and 2026 are the transcribed `
    + "editions (see engine/src/payroll/it/rates.ts). Transcribe the year's Legge di Bilancio, AdE "
    + `provvedimenti, and INPS circular before settling ${taxYear}.`,
  );
}

const paidOf = (ytdBySystemKey: Readonly<Record<string, string>>, key: string): string =>
  ytdBySystemKey[key] ?? "0";

const diffUnits = (annual: string, paid: string): bigint => toUnits(annual) - toUnits(paid);

/** Signed 4dp delta, canonical. */
const diffOf = (annual: string, paid: string): string => fromUnits(diffUnits(annual, paid));

/** Exact signed money subtraction (the paid side nets the assessment). */
const subMoney = (a: string, b: string): string => fromUnits(toUnits(a) - toUnits(b));

function withinDust(annual: string, paid: string): boolean {
  const gap = diffUnits(annual, paid);
  const bound = toUnits(IT_CONGUAGLIO_CREDIT_DUST_TOLERANCE);
  return gap <= bound && gap >= -bound;
}

/**
 * Price the conguaglio and push its lines. DB-free: rates and declaration
 * answers arrive as data; the `compute` closure below resolves them.
 * Returns the stub trace factors. Throws ItPayrollRefusal by name —
 * including the all-or-nothing credit-guard refusal, which pushes nothing.
 */
export function calculateItConguaglio(
  input: ItConguaglioInput,
  pushSettlement: PushStatutoryFn,
): Record<string, string> {
  const tables = tablesFor(input.taxYear);
  if (input.rates == null || input.declaration == null || input.ytdBySystemKey == null) {
    throw new ItPayrollRefusal(
      "IT conguaglio needs tenant rates, the worker's declaration answers, and committed YTD totals — "
      + "a missing one refuses by name (it_addizionale_regionale / it_addizionale_comunale), never settles zero",
    );
  }
  const { declaration, rates } = input;
  const result = calculateItWithTables(
    {
      annualGrossEmployment: input.ytdGross,
      annualPensionable: input.ytdGross,
      nonPeriodicAnnual: "0",
      presumedTotalIncome: declaration.presumedTotalIncome,
      periodsPerYear: 1,
      taxYearWorkDays: input.taxYearWorkDays ?? null,
      regionCode: input.regionCode,
      domicileBolzano: declaration.domicileBolzano,
      comuneCode: declaration.comuneCode,
      regionalRate: rates.regionalRate,
      municipalSurtax: rates.municipalRate == null
        ? null
        : { rate: rates.municipalRate, exemption: rates.municipalExemption },
      sommaBandBase: null,
      hasDetrazioniDeclaration: declaration.hasDetrazioniDeclaration,
      hasFamilyCharges: declaration.hasFamilyCharges,
      isFixedTerm: declaration.isFixedTerm,
      isPost1995: declaration.isPost1995,
      isPensioner: declaration.isPensioner,
      renewalIncrease: declaration.renewalIncrease ?? "0",
      shiftAllowance: declaration.shiftAllowance ?? "0",
      premiRisultato: declaration.premiRisultato ?? "0",
      renewalIncreaseYtd: paidOf(input.ytdBySystemKey, "IT_SUBST_RINNOVI"),
      shiftAllowanceYtd: paidOf(input.ytdBySystemKey, "IT_SUBST_TURNI"),
      premiRisultatoYtd: paidOf(input.ytdBySystemKey, "IT_SUBST_PREMI"),
      priorYearEmploymentIncome: declaration.priorYearEmploymentIncome ?? null,
      premiRisultatoEligible: declaration.premiRisultatoEligible ?? null,
    },
    tables,
  );

  // The credit guard, BEFORE any push: TI/somma ride the monthly rail, and
  // any gap beyond rounding dust is a rapportatura or indebito question the
  // v1 priors cannot answer — refuse the whole employee, push nothing.
  const tiAnnual = result.trattamentoIntegrativo;
  const tiPaid = paidOf(input.ytdBySystemKey, "ti_payout");
  const sommaAnnual = result.somma;
  const sommaPaid = paidOf(input.ytdBySystemKey, "somma_payout");
  if (!withinDust(tiAnnual, tiPaid) || !withinDust(sommaAnnual, sommaPaid)) {
    throw new ItPayrollRefusal(
      `IT ${input.taxYear} conguaglio refuses: trattamento integrativo annuale ${tiAnnual} contro ${tiPaid} gia erogato, `
      + `somma annuale ${sommaAnnual} contro ${sommaPaid} gia erogata — the year is not level in a way the v1 priors `
      + "cannot rapportare al periodo di lavoro (D.L. 3/2020 art. 1 c. 1; L. 207/2024 art. 1 c. 5), and indebiti "
      + "oltre 60 euro si recuperano in dieci rate (L. 207/2024 art. 1 c. 7), a timing no in-product mechanism "
      + "prices (see IT_REFUSED_2025/IT_REFUSED_2026). Verify the rapportata spettanza and settle the residual "
      + "through a pay-run adjustment (engine/src/payroll/run-adjustments.ts); the IRPEF/addizionali conguaglio "
      + "for this employee is left unsettled by this run.",
    );
  }

  const annual = {
    incomeTax: result.irpefNetta,
    regionalSurtax: result.addizionaleRegionale,
    municipalSurtax: result.addizionaleComunale,
  };
  const paid = {
    incomeTax: paidOf(input.ytdBySystemKey, "income_tax"),
    regionalSurtax: paidOf(input.ytdBySystemKey, "regional_surtax"),
    municipalSurtax: paidOf(input.ytdBySystemKey, "municipal_surtax"),
  };
  const delta = {
    incomeTax: diffOf(annual.incomeTax, paid.incomeTax),
    regionalSurtax: diffOf(annual.regionalSurtax, paid.regionalSurtax),
    municipalSurtax: diffOf(annual.municipalSurtax, paid.municipalSurtax),
  };

  // Substitute-regime true-up: the exact annual tax off the realized capped
  // bases, less what the monthly priced shares already withheld (rate times
  // the committed base YTD). Consistent years delta to dust and push nothing.
  const substPaid = {
    rinnovi: fromUnits(r2(mulPct(toUnits(paidOf(input.ytdBySystemKey, "IT_SUBST_RINNOVI")), "5"))),
    turni: fromUnits(r2(mulPct(toUnits(paidOf(input.ytdBySystemKey, "IT_SUBST_TURNI")), "15"))),
    premi: fromUnits(r2(mulPct(toUnits(paidOf(input.ytdBySystemKey, "IT_SUBST_PREMI")), "1"))),
  };
  const substDelta = {
    rinnovi: diffOf(result.sostitutivaRinnovi, substPaid.rinnovi),
    turni: diffOf(result.sostitutivaTurni, substPaid.turni),
    premi: diffOf(result.sostitutivaPremi, substPaid.premi),
  };

  // Direction rides the kind: more tax owed collects (deduction),
  // over-withheld refunds (credit). Zero pushes nothing — the legitimate
  // zero. Amounts stay positive; the contract's push refuses negatives.
  const lines = [
    { systemKey: "income_tax", label: "Conguaglio IRPEF", sequence: 110, signed: delta.incomeTax },
    { systemKey: "regional_surtax", label: "Conguaglio addizionale regionale", sequence: 115, signed: delta.regionalSurtax },
    { systemKey: "municipal_surtax", label: "Conguaglio addizionale comunale", sequence: 120, signed: delta.municipalSurtax },
    { systemKey: "sostitutiva_rinnovi", label: "Conguaglio sostitutiva 5% rinnovi", sequence: 111, signed: substDelta.rinnovi },
    { systemKey: "sostitutiva_turni", label: "Conguaglio sostitutiva 15% turni", sequence: 112, signed: substDelta.turni },
    { systemKey: "sostitutiva_premi", label: "Conguaglio sostitutiva 1% premi", sequence: 113, signed: substDelta.premi },
  ] as const;
  for (const line of lines) {
    const order = cmp(line.signed, "0");
    if (order === 0) continue;
    if (order > 0) {
      pushSettlement(line.systemKey, "deduction", `${line.label} a debito — art. 23 c. 3 DPR 600/1973`, line.signed, line.sequence);
    } else {
      pushSettlement(line.systemKey, "credit", `${line.label} a credito — art. 23 c. 3 DPR 600/1973`, neg(line.signed), line.sequence);
    }
  }

  return {
    CONG_IRPEF_ANNUAL: annual.incomeTax,
    CONG_IRPEF_YTD: paid.incomeTax,
    CONG_IRPEF_DELTA: delta.incomeTax,
    CONG_ADDREG_ANNUAL: annual.regionalSurtax,
    CONG_ADDREG_YTD: paid.regionalSurtax,
    CONG_ADDREG_DELTA: delta.regionalSurtax,
    CONG_ADDCOM_ANNUAL: annual.municipalSurtax,
    CONG_ADDCOM_YTD: paid.municipalSurtax,
    CONG_ADDCOM_DELTA: delta.municipalSurtax,
    CONG_TI_ANNUAL: tiAnnual,
    CONG_TI_PAID: tiPaid,
    CONG_SOMMA_ANNUAL: sommaAnnual,
    CONG_SOMMA_PAID: sommaPaid,
    CONG_SUBST_RINNOVI_ANNUAL: result.sostitutivaRinnovi,
    CONG_SUBST_RINNOVI_YTD: substPaid.rinnovi,
    CONG_SUBST_RINNOVI_DELTA: substDelta.rinnovi,
    CONG_SUBST_TURNI_ANNUAL: result.sostitutivaTurni,
    CONG_SUBST_TURNI_YTD: substPaid.turni,
    CONG_SUBST_TURNI_DELTA: substDelta.turni,
    CONG_SUBST_PREMI_ANNUAL: result.sostitutivaPremi,
    CONG_SUBST_PREMI_YTD: substPaid.premi,
    CONG_SUBST_PREMI_DELTA: substDelta.premi,
  };
}

/**
 * Read the it_detrazioni answers the way the monthly pass does
 * (compute-statutory.ts `computeItStatutoryWithRates`): same declaration,
 * same flags, same presunto expression — refusal parity by construction.
 */
function readSettlementDeclaration(
  certificateFor: PayrollAnnualSettlementContext["certificateFor"],
  bool: PayrollAnnualSettlementContext["bool"],
): ItConguaglioDeclaration {
  const cert = certificateFor("it_detrazioni");
  const answers = cert?.answers ?? {};
  const countOf = (key: string): number => {
    const raw = answers[key];
    if (raw == null || raw === "") return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 0;
  };
  const presumed = answers["reddito_complessivo_presunto"] ?? null;
  const substAmount = (key: string): string => {
    const raw = answers[key];
    return raw == null || raw === "" ? "0" : raw;
  };
  return {
    hasDetrazioniDeclaration: cert !== null,
    hasFamilyCharges: bool(answers["coniuge_a_carico"] ?? null)
      || countOf("figli_a_carico") > 0
      || countOf("altri_familiari_a_carico") > 0,
    isFixedTerm: answers["tempo_determinato"] === "true"
      ? true
      : answers["tempo_determinato"] === "false"
        ? false
        : null,
    renewalIncrease: substAmount("importo_aumenti_rinnovo"),
    shiftAllowance: substAmount("importo_indennita_turni"),
    premiRisultato: substAmount("importo_premi_risultato"),
    priorYearEmploymentIncome: answers["reddito_lavoro_2025"] ?? null,
    premiRisultatoEligible: answers["premi_risultato_ammissibili"] === "true"
      ? true
      : answers["premi_risultato_ammissibili"] === "false"
        ? false
        : null,
    isPost1995: answers["anzianita_post_1995"] == null || answers["anzianita_post_1995"] === ""
      ? undefined
      : bool(answers["anzianita_post_1995"]),
    isPensioner: bool(answers["titolare_pensione"] ?? null),
    presumedTotalIncome: presumed && presumed !== "0" ? presumed : null,
    comuneCode: (answers["domicilio_comune"] ?? null) as string | null,
    domicileBolzano: answers["domicilio_bolzano"] === "true"
      ? true
      : answers["domicilio_bolzano"] === "false"
        ? false
        : null,
  };
}

/**
 * The pack-side declaration: one edition per transcribed year, null
 * otherwise (untranscribed years settle nothing — the monthly path
 * untouched). The `compute` closure resolves tenant rates the way the
 * monthly pass does, nets the assessed prior-year saldo out of the
 * surtax paid side (the committed lines carry advances AND installments),
 * then runs the DB-free core and pushes through the contract's
 * sign-refusing push. The CONG_ADDREG_YTD / CONG_ADDCOM_YTD factors therefore
 * carry the year's N-position paid (withheld less assessed), not the cash
 * total — the CU sums cash lines itself and reads the dovuta below.
 */
export function itAnnualSettlement(taxYear: number): PayrollAnnualSettlement | null {
  if (taxYear !== 2025 && taxYear !== 2026) return null;
  return {
    label: IT_CONGUAGLIO_LABEL,
    citation: IT_CONGUAGLIO_CITATION,
    mode: "adjustment_line",
    requiredEmployeeFacts: [],
    requiredCertificates: [],
    usesTenantRates: [...IT_CONGUAGLIO_TENANT_RATES],
    settlementSystemKey: "income_tax",
    compute: async (ctx: PayrollAnnualSettlementContext): Promise<Record<string, string>> => {
      const declaration = readSettlementDeclaration(ctx.certificateFor, ctx.bool);
      const resolution = await resolveStatutoryRates(
        ctx.orgId,
        IT_PACK_RATES,
        ctx.taxYear,
        ctx.payDate,
      );
      const regionale = resolution.values("it_addizionale_regionale", { region: ctx.region });
      const comunale = declaration.comuneCode
        ? resolution.values("it_addizionale_comunale", {
          region: ctx.region,
          subRegion: declaration.comuneCode,
        })
        : null;
      const push = createSettlementPush(ctx.pushSettlement);
      try {
        // Combined-position settlement: the stub lines the paid side sums
        // carry BOTH the current-year advances and the prior-year saldo
        // installments (same systemKeys — see ./surtax-balances.ts), while
        // the annual recomputation prices this year's liability alone. Net
        // the assessment out of the paid side so the delta settles
        // [liability(N) + assessed(N-1)] against [advances + installments]:
        // every euro attributed to exactly one year's assessment, dust only
        // when the year ran whole. The channel refusal propagates — December
        // cannot settle a year whose saldo source is unknown either.
        const assessed = await resolveItSurtaxAssessed(ctx.tx, {
          orgId: ctx.orgId,
          employeePartyId: ctx.employeePartyId,
          taxYear,
        });
        const paid = { ...ctx.priors.ytdWithheldBySystemKey };
        paid["regional_surtax"] = subMoney(paid["regional_surtax"] ?? "0", assessed.regionale);
        paid["municipal_surtax"] = subMoney(paid["municipal_surtax"] ?? "0", assessed.comunale);
        return calculateItConguaglio(
          {
            taxYear,
            regionCode: ctx.region,
            ytdGross: ctx.priors.ytdGross,
            ytdBySystemKey: paid,
            declaration,
            rates: {
              regionalRate: regionale?.rate ?? null,
              municipalRate: comunale?.rate ?? null,
              municipalExemption: comunale?.exemption ?? null,
            },
          },
          push,
        );
      } catch (error) {
        if (error instanceof ItPayrollRefusal) {
          throw new ItPayrollRefusal(
            `conguaglio ${taxYear} per ${ctx.employeeName}: ${error.message}`,
          );
        }
        throw error;
      }
    },
  };
}
