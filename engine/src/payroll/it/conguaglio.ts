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
 * 730/2026 TABELLA 6 note 2), the +65 euro c. 2 increase (25.001–35.000),
 * the L. 207/2024 c. 6 ulteriore detrazione (whose spettanza c. 7 says to
 * verify in sede di conguaglio), INPS IVS for the lavoro-netto base, the
 * tenant-declared addizionali (D.Lgs. 446/1997 regionale; D.Lgs. 360/1998
 * comunale — acconto/saldo instalment timing stays out of scope per the
 * refused lists; the annual total settles in one line), the trattamento
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
 * (no days-worked), and indebiti oltre 60 euro recover in dieci rate per
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
  type ItYearTables,
} from "./compute-statutory.ts";
import { IT_PACK_RATES } from "./rates.ts";
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
] as const;

export interface ItConguaglioDeclaration {
  /** it_detrazioni on file: detrazioni apply only on declaration (art. 23). */
  hasDetrazioniDeclaration: boolean;
  /** Any art. 12 family charge: gates the 15.001–28.000 TI band, as monthly. */
  hasFamilyCharges: boolean;
  /** Fixed-term contract: art. 13 c. 1 floor 1.380 instead of 690. */
  isFixedTerm: boolean;
  /** Post-1995 seniority: the year's massimale applies. */
  isPost1995: boolean;
  /** Art. 49 c. 2 lett. a) pension income: refused, as monthly. */
  isPensioner?: boolean;
  /** Reddito complessivo presunto from the declaration, when declared. */
  presumedTotalIncome: string | null;
  /** Domicile comune (codice catastale); null refuses the comunale, as monthly. */
  comuneCode: string | null;
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
      regionCode: input.regionCode,
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

  // Direction rides the kind: more tax owed collects (deduction),
  // over-withheld refunds (credit). Zero pushes nothing — the legitimate
  // zero. Amounts stay positive; the contract's push refuses negatives.
  const lines = [
    { systemKey: "income_tax", label: "Conguaglio IRPEF", sequence: 110, signed: delta.incomeTax },
    { systemKey: "regional_surtax", label: "Conguaglio addizionale regionale", sequence: 115, signed: delta.regionalSurtax },
    { systemKey: "municipal_surtax", label: "Conguaglio addizionale comunale", sequence: 120, signed: delta.municipalSurtax },
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
  return {
    hasDetrazioniDeclaration: cert !== null,
    hasFamilyCharges: bool(answers["coniuge_a_carico"] ?? null)
      || countOf("figli_a_carico") > 0
      || countOf("altri_familiari_a_carico") > 0,
    isFixedTerm: bool(answers["tempo_determinato"] ?? null),
    isPost1995: bool(answers["anzianita_post_1995"] ?? null),
    isPensioner: bool(answers["titolare_pensione"] ?? null),
    presumedTotalIncome: presumed && presumed !== "0" ? presumed : null,
    comuneCode: (answers["domicilio_comune"] ?? null) as string | null,
  };
}

/**
 * The pack-side declaration: one edition per transcribed year, null
 * otherwise (untranscribed years settle nothing — the monthly path
 * untouched). The `compute` closure resolves tenant rates the way the
 * monthly pass does, then runs the DB-free core and pushes through the
 * contract's sign-refusing push.
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
        return calculateItConguaglio(
          {
            taxYear,
            regionCode: ctx.region,
            ytdGross: ctx.priors.ytdGross,
            ytdBySystemKey: ctx.priors.ytdWithheldBySystemKey,
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
