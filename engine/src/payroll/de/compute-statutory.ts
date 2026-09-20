/**
 * The DE pack's statutory pass for tax year 2026.
 *
 * Method: the period's pay is a monthly laufenden Arbeitslohn (periodsPerYear
 * 12 only — the SV Beitragsbemessungsgrenzen are monthly figures, so any
 * other frequency is refused by name). Lohnsteuer, Solidaritätszuschlag and
 * the Kirchenlohnsteuer base come straight out of the transcribed PAP
 * (computePapLaufend2026, pap.ts); the four SV branches are assessed on the
 * same gross against the transcribed 2026 ceilings (DE_2026_CEILINGS) and
 * rates (DE_2026_RATES), employee and employer halves.
 *
 * Where each PAP input comes from (both channels the predecessor said were
 * missing, verified against the types):
 * - KVZ: the tenant-entered de_kvz rate slot, read via resolveStatutoryRates
 *   (the F-reg-003 inversion: the pack's rates go in as a PARAMETER, so no
 *   load cycle). Missing → refusal naming the Zusatzbeitrag, never zero or
 *   the BMG average.
 * - Steuerklasse, ZKF, Konfession, Freibetrag/Hinzurechnungsbetrag, Faktor:
 *   the de_elstam certificate answers. No certificate on file → refusal; a
 *   blank Steuerklasse → refusal naming Klasse I (never assumed).
 * - PVZ/PVA (Kinderlosenzuschlag, Abschläge): the de_pv_nachweis
 *   certificate — the employer's PUEG Kindernachweis records, NOT ELStAM
 *   (ELStAM carries no PV child data and ZKF halves cannot be mapped onto
 *   PV children). Blank → refusal, never a silent childless assumption.
 * - PVS (Sachsen): derived from the Land (ctx.region is the
 *   Beschäftigungsland); ALV/KRV/PKV Merker are 0 (see assumptions).
 *
 * What the engine assumes (stated, not hidden): standard fully-liable
 * employment — versicherungspflichtig in all four branches, gesetzlich
 * versichert (ALV/KRV/PKV = 0), income as the single contribution base.
 * Minijob, Werkstudent, PKV, and split-base cases are not modelled; monthly
 * Freibeträge are floor(annual/12), the ≤11ct annual remainder unattributed
 * (stated simplification). Sonstige Bezüge (nonPeriodic ≠ 0) and the
 * Versorgungsbezüge/Altersentlastungsbetrag PAP paths stay refused by name
 * (pap.ts). Kirchenlohnsteuer is 8% in BY/BW, 9% elsewhere (the pack's
 * declared split, EStG §51a base = PAP BK), Cent ↓, computed only when the
 * ELStAM Konfession is non-empty. Umlagen U1/U2/U3 and the
 * Berufsgenossenschaft accrue nothing here — employer levies with no engine.
 *
 * Money: integer Cent throughout (PAP convention); SV halves are
 * half-up to the Cent (kaufmännisch). No floating point on money.
 */
import { toUnits, fromUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import {
  computePapLaufend2026,
  dePapSonstigeBezuegeRefusal,
} from "./pap.ts";
import { DE_2026_CEILINGS, DE_2026_RATES, DE_PACK_RATES } from "./rates.ts";

export class DePayrollRefusal extends PayrollPackError {}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. LST/SOLI/KIST/BK are the PAP's own outputs and
 * KV/RV/AV/PV the four SV branches, employee (_W) and employer (_ER)
 * halves — see the module header.
 */
export const DE_FACTOR_LABELS: Readonly<Record<string, string>> = {
  LST: "Lohnsteuer",
  SOLI: "Solidaritätszuschlag",
  KIST: "Kirchenlohnsteuer",
  BK: "Bemessungsgrundlage Kirchenlohnsteuer (EStG §51a)",
  KV_W: "Krankenversicherung (Arbeitnehmer)",
  KV_ER: "Krankenversicherung (Arbeitgeber)",
  RV_W: "Rentenversicherung (Arbeitnehmer)",
  RV_ER: "Rentenversicherung (Arbeitgeber)",
  AV_W: "Arbeitslosenversicherung (Arbeitnehmer)",
  AV_ER: "Arbeitslosenversicherung (Arbeitgeber)",
  PV_W: "Pflegeversicherung (Arbeitnehmer)",
  PV_ER: "Pflegeversicherung (Arbeitgeber)",
};

const STKL_BY_ROMAN: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6,
};

/** Cents (integer) of a "1234.56" euro string. Sub-cent dust truncates. */
function centsOf(euros: string): number {
  return Number(toUnits(euros) / 100n);
}

/** "1234.56" euro string of integer cents. */
function eurosOf(cents: number): string {
  return fromUnits(BigInt(cents) * 100n);
}

/** Half-up share of a cent base at a milli-percent rate (8750 = 8.75%). */
function shareHalfUp(baseCents: number, milliPercent: number): number {
  return Math.floor((baseCents * milliPercent + 50000) / 100000);
}

export interface DeResolvedRates {
  /** Tenant's Zusatzbeitragssatz in Prozent (2 decimals); null = unconfigured. */
  kvz: number | null;
}

/** Phase 9 — DE pack statutory pass for 2026. Refuses every other year. */
export async function computeDeStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  if (ctx.taxYear !== 2026) {
    throw new DePayrollRefusal(
      `DE payroll pack has no transcribed tables for tax year ${ctx.taxYear}: 2026 is the only `
      + "transcribed edition (BMF Programmablaufplan für den Lohnsteuerabzug 2026, Stand 12.11.2025, "
      + "plus SVRV 2026 — see engine/src/payroll/de/rates.ts).",
    );
  }
  const resolution = await resolveStatutoryRates(ctx.orgId, DE_PACK_RATES, ctx.taxYear, ctx.run.pay_date);
  const kvzRaw = resolution.values("de_kvz")?.rate ?? null;
  const kvz = kvzRaw == null ? null : Number(kvzRaw);
  return computeDeStatutoryWithRates(ctx, {
    kvz: kvz == null || !Number.isFinite(kvz) ? null : Math.round(kvz * 100) / 100,
  });
}

/**
 * The pure half: everything below the year gate, so the wiring is testable
 * without a database (mirrors IT's computeItStatutoryWithRates).
 */
export function computeDeStatutoryWithRates(
  ctx: PayrollStatutoryComputeContext,
  rates: DeResolvedRates,
): Record<string, string> {
  const { pushStatutory, certificateFor, bool } = ctx;

  if (ctx.periodsPerYear !== 12) {
    throw new DePayrollRefusal(
      `DE 2026 engine runs monthly payroll only (periodsPerYear 12): the SV `
      + `Beitragsbemessungsgrenzen are monthly figures and no other frequency is modelled — got ${ctx.periodsPerYear}.`,
    );
  }
  if (ctx.region == null || ctx.region === "") {
    throw new DePayrollRefusal(
      "DE 2026 engine needs the Beschäftigungsland (ctx.region) for the Kirchenlohnsteuer "
      + "rate and the Sachsen PV rule — got none.",
    );
  }
  ctx.assertRegionSupported(ctx.region);
  if (rates.kvz == null) {
    throw new DePayrollRefusal(
      "DE 2026 engine cannot run without the Krankenkasse's own Zusatzbeitragssatz: no de_kvz "
      + "statutory rate is configured for this employer in 2026 — refusing rather than defaulting "
      + "to zero or to the BMG national average.",
    );
  }

  const elstam = certificateFor("de_elstam");
  if (elstam == null || !elstam.onFile) {
    throw new DePayrollRefusal(
      "DE 2026 engine needs retrieved ELStAM (EStG §§39a, 39e): no de_elstam certificate is on "
      + "file for this employee — Lohnsteuer cannot be computed without the Finanzamt's Merkmale.",
    );
  }
  const stklRaw = elstam.answers["steuerklasse"] ?? null;
  if (stklRaw == null || stklRaw === "") {
    throw new DePayrollRefusal(
      "DE 2026 engine has no Steuerklasse on this employee's ELStAM declaration — refusing rather "
      + "than assuming Steuerklasse I.",
    );
  }
  const stkl = STKL_BY_ROMAN[stklRaw];
  if (stkl == null) {
    throw new DePayrollRefusal(
      `DE 2026 engine reads Steuerklasse I–VI from ELStAM — got "${stklRaw}".`,
    );
  }

  const zkfRaw = elstam.answers["kinderfreibetrag_anzahl"] ?? null;
  const zkf = zkfRaw == null || zkfRaw === "" ? 0 : Number(zkfRaw);
  const konfession = elstam.answers["konfession"] ?? null;
  const freibetragAnnual = centsOf(elstam.answers["freibetrag"] ?? "0");
  const hinzuAnnual = centsOf(elstam.answers["hinzurechnungsbetrag"] ?? "0");
  const faktorRaw = elstam.answers["faktor"] ?? null;
  const faktor = faktorRaw == null || faktorRaw === "" ? 1 : Number(faktorRaw);
  const af = (stkl === 4 && faktor !== 1 ? 1 : 0) as 0 | 1;
  if (af === 0 && faktor !== 1 && stkl !== 4) {
    throw new DePayrollRefusal(
      `DE 2026 engine: Faktorverfahren (Faktor ${faktorRaw}) exists only in Steuerklasse IV `
      + `(EStG §39f) — got Steuerklasse ${stklRaw}.`,
    );
  }
  if (af === 1 && freibetragAnnual !== 0) {
    throw new DePayrollRefusal(
      "DE 2026 engine: no Freibetrag beside the Faktor (PAP plausibility: AF = 1 with LZZFREIB).",
    );
  }

  const pvCert = certificateFor("de_pv_nachweis");
  const pvzRaw = pvCert?.answers["kinderlosenzuschlag"] ?? null;
  const pvaRaw = pvCert?.answers["abschlag_kinder"] ?? null;
  if (pvCert == null || !pvCert.onFile || pvzRaw == null || pvzRaw === "" || pvaRaw == null || pvaRaw === "") {
    throw new DePayrollRefusal(
      "DE 2026 engine needs the employee's Pflegeversicherung child facts (PUEG Kindernachweis): "
      + "no complete de_pv_nachweis certificate is on file — refusing rather than silently assuming "
      + "a childless employee.",
    );
  }
  const pvz = bool(pvzRaw) ? 1 : 0;
  const pva = Number(pvaRaw);
  if (!Number.isInteger(pva) || pva < 0 || pva > 4) {
    throw new DePayrollRefusal(
      `DE 2026 engine reads 0–4 PV Abschlag children from the Kindernachweis — got "${pvaRaw}".`,
    );
  }

  if (ctx.nonPeriodic !== "0" && centsOf(ctx.nonPeriodic) !== 0) {
    throw dePapSonstigeBezuegeRefusal();
  }

  const re4 = centsOf(ctx.income);
  const pap = computePapLaufend2026({
    lzz: 2,
    re4,
    stkl,
    zkf,
    af,
    f: af === 1 ? Math.round(faktor * 1000) / 1000 : 1,
    alv: 0,
    krv: 0,
    pkv: 0,
    kvz: rates.kvz,
    pvs: ctx.region === "SN" ? 1 : 0,
    pvz: pvz as 0 | 1,
    pva: pva as 0 | 1 | 2 | 3 | 4,
    r: konfession != null && konfession !== "" ? 1 : 0,
    lzzfreib: Math.floor(freibetragAnnual / 12),
    lzzhinzu: Math.floor(hinzuAnnual / 12),
    pkpv: 0,
    pkpvagz: 0,
  });

  // --- SV: four branches on the same gross, monthly BBGs, halves. ---
  // Quoted figures: KV 14,6 (§241 SGB V) hälftig (§249); RV 18,6 hälftig
  // (§168 SGB VI); AV 2,6 hälftig (§§341/346 SGB III); PV 3,6 + 0,6
  // Kinderlosenzuschlag − 0,25/Kind, Sachsen +1,0 AN (§§55/58 SGB XI) —
  // all transcribed in DE_2026_RATES / DE_2026_CEILINGS with quotes.
  const kvBase = Math.min(re4, Math.round(DE_2026_CEILINGS.kvPbbgMonthly * 100));
  const rvBase = Math.min(re4, Math.round(DE_2026_CEILINGS.rvBbgMonthly * 100));
  const kvzHundredths = Math.round(rates.kvz * 100);
  const kvHalfMilli = (Math.round(DE_2026_RATES.kv * 100) + kvzHundredths) * 5;
  const kvW = shareHalfUp(kvBase, kvHalfMilli);
  const rvHalfMilli = Math.round((DE_2026_RATES.rv / 2) * 1000);
  const rvW = shareHalfUp(rvBase, rvHalfMilli);
  const avHalfMilli = Math.round((DE_2026_RATES.av / 2) * 1000);
  const avW = shareHalfUp(rvBase, avHalfMilli);
  const pvBase = kvBase;
  const pvEmployeeMilli = Math.round(DE_2026_RATES.pv / 2 * 1000)
    + (ctx.region === "SN" ? Math.round(DE_2026_RATES.pvSachsenExtra * 1000) : 0)
    + (pvz === 1 ? Math.round(DE_2026_RATES.pvKinderlosenzuschlag * 1000) : 0)
    - Math.round(DE_2026_RATES.pvKindAbschlag * 1000) * pva;
  const pvEmployerMilli = Math.round(DE_2026_RATES.pv / 2 * 1000)
    - (ctx.region === "SN" ? Math.round(DE_2026_RATES.pvSachsenExtra * 1000) : 0);
  const pvW = shareHalfUp(pvBase, pvEmployeeMilli);
  const pvEr = shareHalfUp(pvBase, pvEmployerMilli);

  // --- Kirchenlohnsteuer on the PAP BK base, where elected. ---
  // 8% in Bayern/Baden-Württemberg, 9% elsewhere (pack-declared split);
  // Cent ↓. Zero (no confession) pushes nothing, like every zero line.
  const kistRate = ctx.region === "BY" || ctx.region === "BW" ? 8 : 9;
  const kist = pap.bk === 0 ? 0 : Math.floor((pap.bk * kistRate) / 100);

  pushStatutory("lohnsteuer", "deduction", "Lohnsteuer", eurosOf(pap.lstlzz), 110);
  pushStatutory("solidaritaetszuschlag", "deduction", "Solidaritätszuschlag", eurosOf(pap.solzlzz), 115);
  pushStatutory("kirchenlohnsteuer", "deduction", "Kirchenlohnsteuer", eurosOf(kist), 117);
  pushStatutory("kv", "deduction", "Krankenversicherung — Arbeitnehmeranteil", eurosOf(kvW), 120);
  pushStatutory("rv", "deduction", "Rentenversicherung — Arbeitnehmeranteil", eurosOf(rvW), 130);
  pushStatutory("av", "deduction", "Arbeitslosenversicherung — Arbeitnehmeranteil", eurosOf(avW), 140);
  pushStatutory("pv", "deduction", "Pflegeversicherung — Arbeitnehmeranteil", eurosOf(pvW), 150);
  pushStatutory("kv", "employer_contribution", "Krankenversicherung — Arbeitgeberanteil", eurosOf(kvW), 210);
  pushStatutory("rv", "employer_contribution", "Rentenversicherung — Arbeitgeberanteil", eurosOf(rvW), 215);
  pushStatutory("av", "employer_contribution", "Arbeitslosenversicherung — Arbeitgeberanteil", eurosOf(avW), 220);
  pushStatutory("pv", "employer_contribution", "Pflegeversicherung — Arbeitgeberanteil", eurosOf(pvEr), 225);

  return {
    LST: eurosOf(pap.lstlzz),
    SOLI: eurosOf(pap.solzlzz),
    KIST: eurosOf(kist),
    BK: eurosOf(pap.bk),
    KV_W: eurosOf(kvW),
    KV_ER: eurosOf(kvW),
    RV_W: eurosOf(rvW),
    RV_ER: eurosOf(rvW),
    AV_W: eurosOf(avW),
    AV_ER: eurosOf(avW),
    PV_W: eurosOf(pvW),
    PV_ER: eurosOf(pvEr),
  };
}
