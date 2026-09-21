/**
 * Germany — the Lohnsteuer-Jahresausgleich (§42b EStG) as the pack's declared
 * annual settlement for 2026.
 *
 * WHY THIS SHAPE. December payroll in a year without a tariff change is
 * governed by the regular monthly PAP (EStG §39b Abs. 2 — annualise the
 * month, withhold a twelfth); no separate December program exists for 2026
 * (December programs are the exceptional vehicle for a mid-year law change:
 * BMF-Schreiben vom 18.10.2024, Stand 18.10.2024 endgültig, Anlage 1, 45
 * pages, for the Existenzminimum-Gesetz Nachholung — including its own
 * UPTAB24N and the Prüftabelle on pp. 43–45). The standing year-end
 * institution is therefore the §42b Ausgleich: the employer recomputes the
 * Jahreslohnsteuer on the true Jahresarbeitslohn (§42b Abs. 2 Satz 3: per
 * §39b Abs. 2 Sätze 6 und 7, i.e. the PAP's own annual path, at the
 * December ELStAM class) and refunds the excess over what was erhoben
 * (Abs. 2 Satz 4) — earliest at the December Abrechnung (Abs. 3 Satz 1),
 * entered separately in the Lohnkonto, and netted into the Bescheinigung's
 * Zeile 4 as erhoben minus erstattet (Abs. 4). The December monthly pass
 * MUST still run (the Ausgleich compares against "insgesamt erhoben",
 * December included), so the edition supplements it: mode
 * `adjustment_line`, a legitimate zero pushing nothing.
 *
 * WHAT SETTLES. Lohnsteuer plus the two lines that ride its base — the
 * Solidaritätszuschlag (SolZG §§3–4: 5,5 % of the Lohnsteuer base with the
 * 11,9 % Milderung) and the Kirchenlohnsteuer base (EStG §51a; 8 % in BY/BW,
 * 9 % elsewhere, the pack's declared split) — each line refunded or not
 * independently (a shortfall line pushes nothing), exactly as the December
 * 2024 program's MLST1224 floors each December difference at zero
 * independently. The edition's `settlementSystemKey` names the primary line
 * (`lohnsteuer`, the only one §42b itself orders); the Soli/KiSt lines post
 * against their own declared slots, which the remittance already nets.
 *
 * WHAT NEVER SETTLES. A shortfall is not collected: §42b refunds "insoweit"
 * the withholding exceeds the annual tax (Abs. 1 Satz 1, Abs. 2 Satz 4),
 * and a post-year-end collection belongs to the Änderung des
 * Lohnsteuerabzugs (§41c Abs. 3 Satz 3), never to the Ausgleich.
 *
 * Money: integer Cent through the PAP, canonical 4-decimal strings on the
 * stub (money.ts). Refunds post positive `credit` lines (net math is
 * gross − deductions + credits); the settlement push refuses negatives.
 */
import { fromUnits, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  isFinalPeriodOfTaxYear,
  type PayrollAnnualSettlement,
  type PayrollAnnualSettlementContext,
} from "../annual-settlement.ts";
import type { PayrollTaxYearDefinition } from "../packs.ts";
import { empFact } from "../employee-facts.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import { STKL_BY_ROMAN } from "./compute-statutory.ts";
import {
  DE_AUSGLEICH_GANZJAEHRIG,
  DE_AUSGLEICH_KEIN_AUSSCHLUSS,
  DE_AUSGLEICH_UNVERAENDERT,
} from "./employee-facts.ts";
import { computePapLaufend2026 } from "./pap.ts";
import { DE_PACK_RATES } from "./rates.ts";

export class DeSettlementRefusal extends PayrollPackError {}

/**
 * The pack's own tax-year definition (mirrors DE_PAYROLL_PACK.taxYear; the
 * edition test pins the equality so the final-period gate cannot drift).
 */
export const DE_SETTLEMENT_TAX_YEAR: PayrollTaxYearDefinition = {
  basis: "calendar",
  startMonth: 1,
  startDay: 1,
  namedBy: "opening_year",
};

/** Settlement trace-factor keys (named in DE_FACTOR_LABELS beside pack.ts). */
export const DE_SETTLEMENT_FACTOR_KEYS = [
  "JAHRESLST",
  "LST_AUSGLEICH",
  "SOLI_AUSGLEICH",
  "KIST_AUSGLEICH",
] as const;

/** Distinct sequences so the Ausgleich stays separately entered (§42b Abs. 4 Satz 1). */
const SEQ_LST_AUSGLEICH = 112;
const SEQ_SOLI_AUSGLEICH = 116;
const SEQ_KIST_AUSGLEICH = 118;

/** Cents (integer) of a canonical 4-decimal money string. Sub-cent dust truncates. */
function centsOf(amount: string): number {
  return Number(toUnits(amount) / 100n);
}

/** Canonical 4-decimal string of integer cents. */
function eurosOf(cents: number): string {
  return fromUnits(BigInt(cents) * 100n);
}

function refuse(what: string): never {
  throw new DeSettlementRefusal(
    `DE Lohnsteuer-Jahresausgleich (§42b EStG) 2026: ${what}`,
  );
}

export interface DeSettlementRates {
  /** Tenant's Zusatzbeitragssatz in Prozent (2 decimals); null = unconfigured. */
  kvz: number | null;
}

/**
 * The pure half: everything below the rate resolution, so the settlement is
 * testable without a database (mirrors computeDeStatutoryWithRates).
 */
export async function computeDeSettlementWithRates(
  ctx: PayrollAnnualSettlementContext,
  rates: DeSettlementRates,
): Promise<Record<string, string>> {
  if (ctx.taxYear !== 2026) {
    refuse(
      `only tax year 2026 is transcribed (BMF Programmablaufplan für den Lohnsteuerabzug 2026, `
      + `Stand 12.11.2025, plus SVRV 2026) — got ${ctx.taxYear}.`,
    );
  }
  if (!isFinalPeriodOfTaxYear(DE_SETTLEMENT_TAX_YEAR, ctx.periodsPerYear, ctx.payDate)) {
    refuse(
      `the Ausgleich runs only in the final period of the tax year (EStG §42b Absatz 3 Satz 1: `
      + `frühestens bei der Lohnabrechnung für den letzten im Ausgleichsjahr endenden `
      + `Lohnzahlungszeitraum) — pay date ${ctx.payDate} is not it.`,
    );
  }
  if (ctx.region == null || ctx.region === "") {
    refuse(
      "the Ausgleich needs the Beschäftigungsland (ctx.region) for the Kirchenlohnsteuer "
      + "rate and the Sachsen PV rule — got none.",
    );
  }
  // The SAME gate the monthly pass calls: a settlement must not quietly
  // succeed where the monthly engine refuses.
  ctx.assertRegionSupported(ctx.region);
  if (rates.kvz == null) {
    refuse(
      "the Ausgleich cannot run without the Krankenkasse's own Zusatzbeitragssatz: no de_kvz "
      + "statutory rate is configured for this employer in 2026 — refusing rather than defaulting "
      + "to zero or to the BMG national average.",
    );
  }

  // Per-employee §42b attestations: missing refuses by name (an assumed yes
  // is a silently wrong refund), denied refuses as excluded. The missing
  // wording ("employee fact <key>") is deliberately identical to the
  // generic missingSettlementInputs scan, which the edition's tests assert
  // in parallel.
  // Literal keys (the house idiom — see JP/ES compute paths): the
  // employee-facts conformance test reads them off the AST, so a const
  // reference here would certify nothing. Drift against the DE_* consts is
  // pinned both ways by that same test (consumed must equal declared).
  const ganzjaehrig = empFact("DE", ctx.emp, "de_ausgleich_ganzjaehrig");
  const unveraendert = empFact("DE", ctx.emp, "de_ausgleich_unveraendert");
  const keinAusschluss = empFact("DE", ctx.emp, "de_ausgleich_kein_ausschluss");
  const absent: string[] = [];
  if (ganzjaehrig == null || ganzjaehrig === "") absent.push(`employee fact ${DE_AUSGLEICH_GANZJAEHRIG}`);
  if (unveraendert == null || unveraendert === "") absent.push(`employee fact ${DE_AUSGLEICH_UNVERAENDERT}`);
  if (keinAusschluss == null || keinAusschluss === "") absent.push(`employee fact ${DE_AUSGLEICH_KEIN_AUSSCHLUSS}`);
  if (absent.length > 0) {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" without the §42b attestations `
      + `(${absent.join(", ")}) — declare each on the employee's Payroll tab from the HR records, `
      + `the ELStAM history and the Lohnkonto; an assumed yes would be a silently wrong refund.`,
    );
  }
  if (!ctx.bool(ganzjaehrig) || !ctx.bool(unveraendert) || !ctx.bool(keinAusschluss)) {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" under §42b Abs. 1 EStG: the attestations `
      + `deny a continuously employed, unchanged, exclusion-free Ausgleichsjahr — this employee `
      + `settles through assessment, never through this settlement.`,
    );
  }

  const elstam = ctx.certificateFor("de_elstam");
  if (elstam == null || !elstam.onFile) {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" without retrieved ELStAM (EStG §§39a, 39e): `
      + `§42b Abs. 2 Satz 3 prices the annual tax at the December Steuerklasse.`,
    );
  }
  const stklRaw = elstam.answers["steuerklasse"] ?? null;
  if (stklRaw == null || stklRaw === "") {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}": no Steuerklasse on the ELStAM declaration — `
      + `refusing rather than assuming Steuerklasse I.`,
    );
  }
  const stkl = STKL_BY_ROMAN[stklRaw];
  if (stkl == null) {
    refuse(`reads Steuerklasse I–VI from ELStAM — got "${stklRaw}".`);
  }
  // §42b Abs. 1 Satz 3 Nr. 2: class V or VI at ANY time bars the Ausgleich —
  // a December V/VI is certainly such a spell.
  if (stkl === 5 || stkl === 6) {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" in Steuerklasse ${stklRaw} (§42b Abs. 1 `
      + `Satz 3 Nr. 2 EStG bars classes V and VI).`,
    );
  }
  // Nr. 3a/3b are certificate-readable: any §39a amount or any Faktor bars.
  const freibetrag = toUnits(elstam.answers["freibetrag"] ?? "0");
  const hinzu = toUnits(elstam.answers["hinzurechnungsbetrag"] ?? "0");
  if (freibetrag !== 0n || hinzu !== 0n) {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" with a §39a Freibetrag or `
      + `Hinzurechnungsbetrag (§42b Abs. 1 Satz 3 Nr. 3a EStG).`,
    );
  }
  const faktorRaw = elstam.answers["faktor"] ?? null;
  const faktor = faktorRaw == null || faktorRaw === "" ? 1 : Number(faktorRaw);
  if (faktor !== 1) {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" under the Faktorverfahren (§42b Abs. 1 `
      + `Satz 3 Nr. 3b EStG bars EStG §39f).`,
    );
  }
  const zkfRaw = elstam.answers["kinderfreibetrag_anzahl"] ?? null;
  const zkf = zkfRaw == null || zkfRaw === "" ? 0 : Number(zkfRaw);
  const konfession = elstam.answers["konfession"] ?? null;

  const pvCert = ctx.certificateFor("de_pv_nachweis");
  const pvzRaw = pvCert?.answers["kinderlosenzuschlag"] ?? null;
  const pvaRaw = pvCert?.answers["abschlag_kinder"] ?? null;
  if (pvCert == null || !pvCert.onFile || pvzRaw == null || pvzRaw === "" || pvaRaw == null || pvaRaw === "") {
    refuse(
      `no Ausgleich for employee "${ctx.employeeName}" without the Pflegeversicherung child facts `
      + `(PUEG Kindernachweis) — refusing rather than silently assuming a childless employee.`,
    );
  }
  const pvz = ctx.bool(pvzRaw) ? 1 : 0;
  const pva = Number(pvaRaw);
  if (!Number.isInteger(pva) || pva < 0 || pva > 4) {
    refuse(`reads 0–4 PV Abschlag children from the Kindernachweis — got "${pvaRaw}".`);
  }

  // --- Annual recomputation on the true Jahresarbeitslohn ---
  // §42b Abs. 2 Satz 2–3: the Jahresarbeitslohn aus dem Dienstverhältnis
  // (the committed year-to-date gross, December included), priced as
  // Jahreslohnsteuer nach §39b Abs. 2 Sätzen 6 und 7 — which is exactly the
  // PAP's annual (LZZ 1) path: no annualisation, annual ceilings, the
  // December ELStAM class. Freibetrag/Hinzurechnungsbetrag and the
  // Faktorverfahren are refused above (Nr. 3a/3b), so both annual §39a
  // inputs are zero here; Versorgungsbezüge and the Altersentlastungsbetrag
  // are refused PAP paths, so no Abs. 2 Satz 2 deduction applies.
  const ytdCents = centsOf(ctx.priors.ytdGross);
  const annual = computePapLaufend2026({
    lzz: 1,
    re4: ytdCents,
    stkl,
    zkf,
    af: 0,
    f: 1,
    alv: 0,
    krv: 0,
    pkv: 0,
    kvz: rates.kvz,
    pvs: ctx.region === "SN" ? 1 : 0,
    pvz: pvz as 0 | 1,
    pva: pva as 0 | 1 | 2 | 3 | 4,
    r: konfession != null && konfession !== "" ? 1 : 0,
    lzzfreib: 0,
    lzzhinzu: 0,
    pkpv: 0,
    pkpvagz: 0,
  });
  const annualLstC = annual.lstjahr * 100;
  const annualSoliC = annual.solzj;
  // Kirchenlohnsteuer on the annual BK base, where elected: 8 % in BY/BW,
  // 9 % elsewhere (the pack's declared split, EStG §51a base) — the same
  // rule the monthly pass applies, now on the annual base.
  const kistRate = ctx.region === "BY" || ctx.region === "BW" ? 8 : 9;
  const annualKistC = annual.bk === 0 ? 0 : Math.floor((annual.bk * kistRate) / 100);

  const withheldLstC = centsOf(ctx.priors.ytdWithheldBySystemKey["lohnsteuer"] ?? "0.0000");
  const withheldSoliC = centsOf(ctx.priors.ytdWithheldBySystemKey["solidaritaetszuschlag"] ?? "0.0000");
  const withheldKistC = centsOf(ctx.priors.ytdWithheldBySystemKey["kirchenlohnsteuer"] ?? "0.0000");

  const push = ctx.pushSettlement;
  const refundLstC = withheldLstC - annualLstC;
  const refundSoliC = withheldSoliC - annualSoliC;
  const refundKistC = withheldKistC - annualKistC;
  if (refundLstC > 0) {
    push("lohnsteuer", "credit", "Lohnsteuer-Jahresausgleich (§42b EStG) — Erstattung", eurosOf(refundLstC), SEQ_LST_AUSGLEICH);
  }
  if (refundSoliC > 0) {
    push("solidaritaetszuschlag", "credit", "Solidaritätszuschlag zum Jahresausgleich (§42b EStG) — Erstattung", eurosOf(refundSoliC), SEQ_SOLI_AUSGLEICH);
  }
  if (refundKistC > 0) {
    push("kirchenlohnsteuer", "credit", "Kirchenlohnsteuer zum Jahresausgleich (§42b EStG) — Erstattung", eurosOf(refundKistC), SEQ_KIST_AUSGLEICH);
  }

  return {
    JAHRESLST: eurosOf(annualLstC),
    LST_AUSGLEICH: eurosOf(Math.max(refundLstC, 0)),
    SOLI_AUSGLEICH: eurosOf(Math.max(refundSoliC, 0)),
    KIST_AUSGLEICH: eurosOf(Math.max(refundKistC, 0)),
  };
}

/** The DB-backed entry point: resolves the fund's own KVZ, then the pure half. */
export async function computeDeSettlement(
  ctx: PayrollAnnualSettlementContext,
): Promise<Record<string, string>> {
  const resolution = await resolveStatutoryRates(ctx.orgId, DE_PACK_RATES, ctx.taxYear, ctx.payDate);
  const kvzRaw = resolution.values("de_kvz")?.rate ?? null;
  const kvz = kvzRaw == null ? null : Number(kvzRaw);
  return computeDeSettlementWithRates(ctx, {
    kvz: kvz == null || !Number.isFinite(kvz) ? null : Math.round(kvz * 100) / 100,
  });
}

/**
 * The 2026 settlement edition. Untranscribed years resolve to null: settle
 * nothing, never a guessed program. Should the BMF publish a December-2026
 * program superseding the monthly PAP (none exists as of September 2026 —
 * December programs are the exceptional tariff-change vehicle, e.g. the
 * 18.10.2024 program for the Existenzminimum-Gesetz), it arrives as a
 * second 2026 edition carrying mode `final_period_recomputation`, not as an
 * edit to this one.
 */
export function deAnnualSettlement(taxYear: number): PayrollAnnualSettlement | null {
  if (taxYear !== 2026) return null;
  return {
    label: "Lohnsteuer-Jahresausgleich (§42b EStG)",
    citation:
      "EStG §42b (Lohnsteuer-Jahresausgleich durch den Arbeitgeber: Abs. 2 Sätze 3–4 "
      + "Rechenweg, Abs. 3 Satz 1 frühestens Dezember, Abs. 4 Lohnkonto/Bescheinigung); "
      + "EStG §39b Abs. 2 Sätze 6–7 (Jahreslohnsteuer; Monatslohnsteuer als Zwölftel); "
      + "EStG §41b Abs. 1 Satz 2 Nr. 4 (Bescheinigung: einbehaltene Lohnsteuer, Soli, KiSt); "
      + "EStG §41c Abs. 3 (Änderung nach Ablauf des Jahres — keine Ausgleichs-Nachforderung); "
      + "SolZG §§3–4 (Bemessung, 5,5 %, 11,9 % Milderung); EStG §51a "
      + "(Kirchenlohnsteuer-Bemessung); BMF Programmablaufplan für den Lohnsteuerabzug 2026 "
      + "(BMF-Schreiben vom 12.11.2025, Stand 12.11.2025 endgültig, Anlage 1 — annual path); "
      + "SVRV 2026 (bundeseinheitliche ceilings); SGB XI §§55/58 (PV Abschläge, Sachsen)",
    mode: "adjustment_line",
    requiredEmployeeFacts: [
      DE_AUSGLEICH_GANZJAEHRIG,
      DE_AUSGLEICH_UNVERAENDERT,
      DE_AUSGLEICH_KEIN_AUSSCHLUSS,
    ],
    requiredCertificates: ["de_elstam", "de_pv_nachweis"],
    usesTenantRates: ["de_kvz"],
    settlementSystemKey: "lohnsteuer",
    compute: computeDeSettlement,
  };
}
