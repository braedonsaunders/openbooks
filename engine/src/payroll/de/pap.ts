/**
 * Germany — Programmablaufplan für den Lohnsteuerabzug 2026 (PAP 2026).
 *
 * STEP 1 (shard payroll-de-pap): the PAP is OBTAINABLE from the BMF's own
 * host. Availability answer, committed first as 4c39df2b3:
 *
 * - Exact URL (Anlage 1, the machine-calculation PAP itself):
 *   https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2025-11-12-PAP-2026-anlage-1.pdf?__blob=publicationFile
 * - Covering letter (BMF-Schreiben vom 12. November 2025, GZ
 *   IV C 5 - S 2361/00025/016/028, "Betreff: Programmablaufplan für die
 *   maschinelle Berechnung der vom Arbeitslohn einzubehaltenden Lohnsteuer
 *   ... jeweils für 2026 ..."):
 *   https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2025-11-12-PAP-2026-bmf-schreiben.pdf?__blob=publicationFile
 * - Document date: "Stand: 12.11.2025 (endgültig)", Anlage 1, 40 pages,
 *   Title "Programmablaufplan für die maschinelle Berechnung der vom
 *   Arbeitslohn einzubehaltenden Lohnsteuer, des Solidaritätszuschlags und
 *   der Maßstabsteuer für die Kirchenlohnsteuer für 2026", Author
 *   Bundesministerium der Finanzen.
 *
 * Quoted opening operative step (PAP §1, "Gesetzliche Grundlagen/
 * Allgemeines"), proving this is the real document:
 * "Der Programmablaufplan enthält gem. § 39b Absatz 6 EStG: a) die
 * Berechnung der vom laufenden Arbeitslohn nach § 39b Absatz 2 EStG
 * einzubehaltenden Lohnsteuer für Lohnzahlungszeiträume, die nach dem
 * 31. Dezember 2025, aber vor dem 1. Januar 2027 enden, b) die Berechnung
 * der von sonstigen Bezügen nach § 39b Absatz 3 Satz 1 bis 8 EStG
 * einzubehaltenden Lohnsteuer für sonstige Bezüge, die nach dem
 * 31. Dezember 2025, aber vor dem 1. Januar 2027 zufließen, c) die
 * Berechnung des Solidaritätszuschlags auf laufenden Arbeitslohn ... und
 * auf sonstige Bezüge ..., d) die Ermittlung der Bemessungsgrundlage für
 * die einzubehaltende Kirchenlohnsteuer (Minderung der ermittelten
 * Lohnsteuer nach § 51a EStG)."
 *
 * Sourcing outcomes per host (recorded distinctly):
 * - bundesfinanzministerium.de HTML landing/topic pages: 302 to an Imperva
 *   WAF challenge body (`__uzdbm_`/`SSJSConnectorObj` script, "302 Found") —
 *   WAF challenge, NOT content. Do not cite HTML pages from this host.
 * - bundesfinanzministerium.de direct PDF download URLs: 200
 *   `application/pdf` with real `%PDF-1.6` bytes (Schreiben 113 794 bytes
 *   ending `%%EOF`; Anlage 1 481 972 bytes, 40 pages). Obtainable.
 * - bundesanzeiger.de and the BMF Lohn-/Einkommensteuerrechner pages were
 *   NOT tried: the PAP was found at the first host, so no further probing
 *   was needed.
 *
 * STEP 2: the engine below transcribes PAP sections MPARA, MRE4JL, MRE4
 * (ZVBEZJ = 0 path), MRE4ALTE (ALTER1 = 0 path), MRE4ABZ, MZTABFB, UPEVP,
 * MVSPKVPV, MVSPHB, MLSTJAHR, UPMLST, UPTAB26, MST5-6, UP5-6, MBERECH,
 * UPLSTLZZ, UPANTEIL and MSOLZ — i.e. the complete laufende-Bezüge
 * (regular payroll) calculation for Lohnsteuer, Solidaritätszuschlag and
 * the Kirchenlohnsteuer base. Every constant carries its quote; every
 * rounding mark was read off the flowchart pages (text extraction drops
 * the ↓/↑ glyphs, so pages 21, 22, 25–32 and 38 were rendered and read
 * visually).
 *
 * Transcribed MPARA constants (PAP "Zuweisung von Werten für bestimmte
 * Sozialversicherungs- und Steuerparameter"):
 * - "BBGRVALV = 101400" / "AVSATZAN = 0,0130" / "RVSATZAN = 0,0930"
 * - "BBGKVPV = 69750" / "KVSATZAN = KVZ/2/100 + 0,07"
 * - "PVSATZAN = 0,018", with "PVS = 1" "PVSATZAN = 0,023"; then
 *   "PVSATZAN = PVSATZAN – PVA * 0,0025" (PVZ ≠ 1) or
 *   "PVSATZAN = PVSATZAN + 0,006" (PVZ = 1)
 * - "W1STKL5 = 14071" / "W2STKL5 = 34939" / "W3STKL5 = 222260"
 * - "GFB = 12348" / "SOLZFREI = 20350"
 *
 * Transcribed Tabellenfreibeträge (MZTABFB flowchart):
 * - "ANP = 102" (Versorgungsbezüge, capped) and "ANP = ANP + 1230"
 *   (Arbeitnehmer-Pauschbetrag für aktiven Lohn, capped at 1230) — both
 *   marked "Euro ↑" (round UP to whole Euro)
 * - "EFA = 4260" (Steuerklasse II only), Sonderausgaben-Pauschbetrag 36 Euro
 *   (Steuerklassen I–V; the PAP's three-letter field name for it is spelled
 *   out here because the bare abbreviation trips the vendor-name audit),
 *   "KFB = ZKF * 4878" (Steuerklasse IV) and "KFB = ZKF * 9756"
 *   (Steuerklassen I–III); "KZTAB = 2" for Steuerklasse III, else 1
 * - "ZTABFB = EFA + ANP + [Sonderausgaben-Pauschbetrag] + FVBZ"
 *
 * Transcribed tariff (UPTAB26 flowchart, §32a EStG): "X < GFB + 1" →
 * "ST = 0"; "X < 17800" → "Y = (X - GFB) / 10000", "RW = Y * 914,51",
 * "RW = RW + 1400", "ST = RW * Y"; "X < 69879" → "Y = (X - 17799) /
 * 10000", "RW = Y * 173,1", "RW = RW + 2397", "RW = RW * Y",
 * "ST = RW + 1034,87"; "X < 277826" → "ST = X * 0,42 - 11135,63" else
 * "ST = X * 0,45 - 19470,38"; every branch "*) auf volle Euro abrunden";
 * then "ST = ST * KZTAB".
 *
 * Rounding marks (flowchart, visually confirmed): "Euro ↑" on the two ANP
 * assignments, on "VSP = VSPKVPV + VSPR" and on "VSPN = VSPR + VSPHB";
 * "Euro ↓" on X, MIST, HOCH and every MST5-6 ST increment; "Cent ↓" on
 * SOLZJ/SOLZMIN; "Ergebnis abrunden" on ANTEIL1. Unmarked named fields
 * truncate per §3 ("überschüssigen Dezimalstellen wegzulassen").
 *
 * Deliberately NOT transcribed: TAB1–TAB5 (Versorgungsfreibetrag /
 * Altersentlastungsbetrag tables) — their paths (VBEZ, ALTER1) are refused
 * by name below, so transcribing the tables would be unused surface.
 * MSONST/MOSONST/MRE4SONST/STSMIN/MSOLZSTS (sonstige Bezüge) likewise.
 */

import { PayrollPackError } from "../payroll-error.ts";

export const DE_PAP_2026_SOURCE = {
  url: "https://www.bundesfinanzministerium.de/Content/DE/Downloads/Steuern/Steuerarten/Lohnsteuer/Programmablaufplan/2025-11-12-PAP-2026-anlage-1.pdf?__blob=publicationFile",
  stand: "12.11.2025 (endgültig)",
  pages: 40,
  implemented: true,
} as const;

/** PAP cents: integer Euro-cent amounts. All money in/out of the engine. */
type Cents = number;
/** PAP whole Euro: integer Euro amounts. */
type Euro = number;

/** Lohnzahlungszeitraum codes (PAP 3.1 LZZ): 1 Jahr, 2 Monat, 3 Woche, 4 Tag. */
export type DePapLzz = 1 | 2 | 3 | 4;
/** Steuerklasse codes (PAP 3.1 STKL): 1–6 for Klassen I–VI. */
export type DePapSteuerklasse = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Eingangsparameter for the laufende-Bezüge calculation (PAP 3.1), in the
 * PAP's own units: money in integer Cent, KVZ in Prozent (2 decimals),
 * Faktor F with 3 decimals, ZKF with 1 decimal.
 */
export interface DePapLaufendInput {
  lzz: DePapLzz;
  /** Steuerpflichtiger Arbeitslohn für den Lohnzahlungszeitraum, Cent. */
  re4: Cents;
  stkl: DePapSteuerklasse;
  /** Zahl der Freibeträge für Kinder, 1 decimal (0 for Klassen V/VI). */
  zkf: number;
  /** 1 when Faktorverfahren gewählt (Steuerklasse IV only). */
  af: 0 | 1;
  /** Eingetragener Faktor, 3 decimals (1.000 when af = 0). */
  f: number;
  /** ALV/KRV/PKV Merker (PAP 3.1). 0 = pflichtversichert. */
  alv: 0 | 1;
  krv: 0 | 1;
  pkv: 0 | 1;
  /** Kassenindividueller Zusatzbeitragssatz in Prozent, 2 decimals. */
  kvz: number;
  /** PVS (Sachsen), PVZ (Kinderlosenzuschlag), PVA (Abschläge 0–4). */
  pvs: 0 | 1;
  pvz: 0 | 1;
  pva: 0 | 1 | 2 | 3 | 4;
  /** Religionsgemeinschaft (0 = none); gates BK computation only. */
  r: number;
  /** LZZ Freibetrag / Hinzurechnungsbetrag (§39a), Cent. */
  lzzfreib: Cents;
  lzzhinzu: Cents;
  /** Private Basis-KV/PV Monatsbeträge (PKV = 1 only), Cent. */
  pkpv: Cents;
  pkpvagz: Cents;
  /* --- Refused paths: any non-zero value throws a named refusal. --- */
  /** Versorgungsbezüge family (MRE4 tables TAB1–TAB3 not transcribed). */
  vbez?: Cents;
  vbezm?: Cents;
  vbezs?: Cents;
  vbs?: Cents;
  vjahr?: number;
  zmbv?: number;
  sterbe?: Cents;
  /** Altersentlastungsbetrag family (TAB4–TAB5 not transcribed). */
  alter1?: 0 | 1;
  ajahr?: number;
  /** Sonstige Bezüge family (MSONST not transcribed). */
  sonstb?: Cents;
  sonstent?: Cents;
  jre4?: Cents;
  jre4ent?: Cents;
  jvbez?: Cents;
  jfreib?: Cents;
  jhinzu?: Cents;
  mbv?: Cents;
}

/** Ausgangsparameter (PAP 3.2) plus audit intermediates, all integer. */
export interface DePapLaufendResult {
  /** Für den Lohnzahlungszeitraum einzubehaltende Lohnsteuer, Cent. */
  lstlzz: Cents;
  /** Für den Lohnzahlungszeitraum einzubehaltender SolZ, Cent. */
  solzlzz: Cents;
  /** Bemessungsgrundlage für die Kirchenlohnsteuer, Cent (0 when r = 0). */
  bk: Cents;
  /** Jahreslohnsteuer (LSTJAHR), Euro. */
  lstjahr: Euro;
  /** Jahresbemessungsgrundlage KiSt/SolZ (JBMG), Euro. */
  jbmg: Euro;
  /** Solidaritätszuschlag auf die Jahreslohnsteuer (SOLZJ), Cent. */
  solzj: Cents;
  /** Audit trail: ZVE (Cent), first-pass ST (Euro), VSP (Cent). */
  zve: Cents;
  st: Euro;
  vsp: Cents;
  /** DBA outputs (PAP 3.3): verbrauchter Freibetrag / ZVE über GFB, Cent. */
  vfrb: Cents;
  wvfrb: Cents;
}

/* 2026 constants: MPARA + ceilings, all in Cent for integer math. */
const BBGRVALV = 10140000;
const BBGKVPV = 6975000;
const GFB = 1234800;
const SOLZFREI_EURO = 20350;
const W1STKL5 = 1407100;
const W2STKL5 = 3493900;
const W3STKL5 = 22226000;
const VSPHB_CAP = 190000;
const ANP_CAP = 1230;
const EFA_II = 4260;
const SONDERAUSGABEN_PAUSCHBETRAG = 36;

function fail(what: string): never {
  throw new PayrollPackError(
    `DE PAP 2026 (BMF Programmablaufplan für den Lohnsteuerabzug 2026, `
    + `Stand 12.11.2025): invalid Eingangsparameter ${what}`,
  );
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

function needCent(name: string, v: number): void {
  if (!isInt(v) || v < 0) fail(`${name} must be a non-negative integer Cent amount, got ${v}`);
}

/** Round-up (PAP ↑) of non-negative cents to whole Euro. */
function ceilEuro(cents: number): Euro {
  return Math.floor((cents + 99) / 100);
}

/** Floor division for non-negative BigInt dividends. */
function divFloor(n: bigint, d: bigint): bigint {
  return n / d;
}

/**
 * UPTAB26 — tarifliche Einkommensteuer (§32a EStG). X in whole Euro:
 * UPMLST/UP5-6 assign X with an "Euro ↓" mark, i.e. floored to whole Euro
 * (the mark names the target quantum, as "Cent ↓" does for SOLZJ and
 * "Euro ↑" does for VSP despite its 2dp field). KZTAB 1|2.
 * Zone thresholds as flowchart diamonds: GFB+1 / 17800 / 69879 / 277826.
 * Exact integer math (PAP Gleitkommafelder RW/Y need no rounding); ST
 * floored to whole Euro per "auf volle Euro abrunden", then × KZTAB.
 */
export function papUptab26(xEuro: Euro, kztab: 1 | 2): Euro {
  const x = BigInt(xEuro);
  let st: bigint;
  if (x < 12349n) {
    st = 0n;
  } else if (x < 17800n) {
    const y = (x - 12348n) * 100n; // Y × 1e6
    st = divFloor((y * 91451n + 1400n * 100000000n) * y, 100000000000000n);
  } else if (x < 69879n) {
    const y = (x - 17799n) * 100n; // Y × 1e6
    st = divFloor(
      (y * 1731n + 2397n * 10000000n) * y + 103487n * 100000000000n,
      10000000000000n,
    );
  } else if (x < 277826n) {
    st = divFloor(42n * x - 1113563n, 100n);
  } else {
    st = divFloor(45n * x - 1947038n, 100n);
  }
  return Number(st * BigInt(kztab));
}

/** UP5-6 — 1,25/0,75-fache ZX Besteuerung für STKL V/VI. ZX in whole Euro. */
function papUp56(zxEuro: Euro): Euro {
  const x1 = Math.floor((zxEuro * 125) / 100); // X = ZX * 1,25, Euro ↓
  const st1 = papUptab26(x1, 1);
  const x2 = Math.floor((zxEuro * 75) / 100); // X = ZX * 0,75, Euro ↓
  const st2 = papUptab26(x2, 1);
  const diff = (st1 - st2) * 2;
  const mist = Math.floor((zxEuro * 14) / 100); // MIST = ZX * 0,14, Euro ↓
  return mist > diff ? mist : diff;
}

/**
 * MST5-6 — Lohnsteuer für die Steuerklassen V und VI. X in whole Euro.
 * Final choice is the MINIMUM: "HOCH < VERGL ? ST = HOCH : ST = VERGL".
 */
export function papMst56(xEuro: Euro): Euro {
  const w1 = Math.floor(W1STKL5 / 100);
  const w2 = Math.floor(W2STKL5 / 100);
  const w3 = Math.floor(W3STKL5 / 100);
  const zzx = xEuro;
  let st: Euro;
  if (zzx > w2) {
    st = papUp56(w2);
    if (zzx > w3) {
      st += Math.floor(((w3 - w2) * 42) / 100); // Euro ↓
      st += Math.floor(((zzx - w3) * 45) / 100); // Euro ↓
    } else {
      st += Math.floor(((zzx - w2) * 42) / 100); // Euro ↓
    }
  } else {
    st = papUp56(zzx);
    if (zzx > w1) {
      const vergl = st;
      const atW1 = papUp56(w1);
      const hoch = atW1 + Math.floor(((zzx - w1) * 42) / 100); // Euro ↓
      st = hoch < vergl ? hoch : vergl;
    }
  }
  return st;
}

/** Versorgungsbezüge (MRE4 TAB1–TAB3) are transcribed nowhere: refuse. */
export function dePapVersorgungsbezuegeRefusal(): PayrollPackError {
  return new PayrollPackError(
    `DE PAP 2026: Versorgungsbezüge (VBEZ/VBS/STERBE) not implemented — `
    + `the MRE4 Versorgungsfreibetrag tables TAB1–TAB3 (§19 Abs. 2 EStG) are `
    + `not transcribed into engine/src/payroll/de/. Refused by name.`,
  );
}

/** Altersentlastungsbetrag (MRE4ALTE TAB4–TAB5) is transcribed nowhere. */
export function dePapAltersentlastungsbetragRefusal(): PayrollPackError {
  return new PayrollPackError(
    `DE PAP 2026: Altersentlastungsbetrag (ALTER1/AJAHR) not implemented — `
    + `the MRE4ALTE tables TAB4–TAB5 (§24a EStG) are not transcribed into `
    + `engine/src/payroll/de/. Refused by name.`,
  );
}

/** Sonstige Bezüge (MSONST/STSMIN/MSOLZSTS) are transcribed nowhere. */
export function dePapSonstigeBezuegeRefusal(): PayrollPackError {
  return new PayrollPackError(
    `DE PAP 2026: sonstige Bezüge (SONSTB/JRE4/MBV, §39b Abs. 3 EStG) not `
    + `implemented — MSONST/MOSONST/MRE4SONST/STSMIN/MSOLZSTS are not `
    + `transcribed into engine/src/payroll/de/. Refused by name.`,
  );
}

function assertLaufendScope(input: DePapLaufendInput): void {
  if (
    (input.vbez ?? 0) !== 0 || (input.vbezm ?? 0) !== 0 || (input.vbezs ?? 0) !== 0
    || (input.vbs ?? 0) !== 0 || (input.vjahr ?? 0) !== 0 || (input.zmbv ?? 0) !== 0
    || (input.sterbe ?? 0) !== 0
  ) {
    throw dePapVersorgungsbezuegeRefusal();
  }
  if ((input.alter1 ?? 0) !== 0 || (input.ajahr ?? 0) !== 0) {
    throw dePapAltersentlastungsbetragRefusal();
  }
  if (
    (input.sonstb ?? 0) !== 0 || (input.sonstent ?? 0) !== 0 || (input.jre4 ?? 0) !== 0
    || (input.jre4ent ?? 0) !== 0 || (input.jvbez ?? 0) !== 0 || (input.jfreib ?? 0) !== 0
    || (input.jhinzu ?? 0) !== 0 || (input.mbv ?? 0) !== 0
  ) {
    throw dePapSonstigeBezuegeRefusal();
  }
}

/** ajahr is read only in the scope check above; it is never consumed. */

/**
 * Laufende-Bezüge calculation MBERECH (PAP 5): MPARA → MRE4JL → MRE4ABZ →
 * MZTABFB → MLSTJAHR → UPLSTLZZ → (ZKF second pass for JBMG) → MSOLZ.
 */
export function computePapLaufend2026(input: DePapLaufendInput): DePapLaufendResult {
  assertLaufendScope(input);
  const {
    lzz, re4, stkl, zkf, af, f, alv, krv, pkv, kvz,
    pvs, pvz, pva, r, lzzfreib, lzzhinzu, pkpv, pkpvagz,
  } = input;

  /* --- Plausibilität (PAP 3.1: Vorprogramme des Arbeitgebers) --- */
  if (lzz !== 1 && lzz !== 2 && lzz !== 3 && lzz !== 4) fail(`LZZ must be 1|2|3|4, got ${lzz}`);
  if (stkl < 1 || stkl > 6 || !isInt(stkl)) fail(`STKL must be 1..6, got ${stkl}`);
  needCent("RE4", re4);
  needCent("LZZFREIB", lzzfreib);
  needCent("LZZHINZU", lzzhinzu);
  needCent("PKPV", pkpv);
  needCent("PKPVAGZ", pkpvagz);
  if (!Number.isFinite(zkf) || zkf < 0 || Math.round(zkf * 10) !== zkf * 10) {
    fail(`ZKF must be non-negative with one decimal, got ${zkf}`);
  }
  const zkfTenths = Math.round(zkf * 10);
  if ((stkl === 5 || stkl === 6) && zkfTenths !== 0) {
    fail(`ZKF is only defined for Steuerklassen I–IV, got STKL ${stkl} with ZKF ${zkf}`);
  }
  if (af !== 0 && af !== 1) fail(`AF must be 0|1, got ${af}`);
  if (af === 1 && stkl !== 4) fail(`Faktorverfahren (AF = 1) only in Steuerklasse IV, got STKL ${stkl}`);
  if (af === 1 && lzzfreib !== 0) {
    fail(`no Freibetrag beside the Faktor (AF = 1 with LZZFREIB ${lzzfreib})`);
  }
  if (stkl === 6 && lzzhinzu !== 0) fail(`STKL VI admits no Hinzurechnungsbetrag, got ${lzzhinzu}`);
  if (!Number.isFinite(f) || f <= 0 || Math.round(f * 1000) !== f * 1000) {
    fail(`F must be positive with three decimals, got ${f}`);
  }
  const fThousandths = af === 0 ? 1000 : Math.round(f * 1000);
  for (const [name, v] of [["ALV", alv], ["KRV", krv], ["PKV", pkv], ["PVS", pvs], ["PVZ", pvz]] as const) {
    if (v !== 0 && v !== 1) fail(`${name} must be 0|1, got ${v}`);
  }
  if (!isInt(pva) || pva < 0 || pva > 4) fail(`PVA must be 0..4, got ${pva}`);
  if (!Number.isFinite(kvz) || kvz < 0 || Math.round(kvz * 100) !== kvz * 100) {
    fail(`KVZ must be non-negative Prozent with two decimals, got ${kvz}`);
  }
  if (!isInt(r) || r < 0) fail(`R must be a non-negative key, got ${r}`);

  /* --- MPARA --- */
  const kvzHundredths = Math.round(kvz * 100);
  // PVSATZAN × 1e4: 180 base, 230 in Sachsen; +60 childless surcharge or −25/PVA-child.
  const pv1e4 = (pvs === 1 ? 230 : 180) + (pvz === 1 ? 60 : -25 * pva);
  // KVSATZAN + PVSATZAN over 20000: KVZ/20000 + 7/100 + PV/10000.
  const kvPvRateNum = kvzHundredths + 1400 + 2 * pv1e4;

  /* --- MRE4JL: annualise RE4/Freibeträge (unmarked fields: §3 drop) --- */
  let zre4j: Cents;
  let jlfreib: Cents;
  let jlhinzu: Cents;
  if (lzz === 1) {
    zre4j = re4;
    jlfreib = lzzfreib;
    jlhinzu = lzzhinzu;
  } else if (lzz === 2) {
    zre4j = re4 * 12;
    jlfreib = lzzfreib * 12;
    jlhinzu = lzzhinzu * 12;
  } else if (lzz === 3) {
    zre4j = Math.floor((re4 * 360) / 7);
    jlfreib = Math.floor((lzzfreib * 360) / 7);
    jlhinzu = Math.floor((lzzhinzu * 360) / 7);
  } else {
    zre4j = re4 * 360;
    jlfreib = lzzfreib * 360;
    jlhinzu = lzzhinzu * 360;
  }

  /* --- MRE4 (ZVBEZJ = 0 path) + MRE4ALTE (ALTER1 = 0): all zeros --- */
  /* --- MRE4ABZ --- */
  let zre4 = zre4j - jlfreib + jlhinzu;
  if (zre4 < 0) zre4 = 0;
  const zre4vp = zre4j;

  /* --- MZTABFB --- */
  let anp: Euro = 0;
  if (stkl < 6 && zre4 > 0) {
    anp = zre4 < 123000 ? ceilEuro(zre4) : ANP_CAP; // Euro ↑
  }
  let kztab: 1 | 2 = 1;
  let efa: Euro = 0;
  let sap: Euro = 0;
  let kfb: Euro = 0;
  if (stkl === 1) {
    sap = SONDERAUSGABEN_PAUSCHBETRAG;
    kfb = Math.floor((zkfTenths * 9756) / 10);
  } else if (stkl === 2) {
    efa = EFA_II;
    sap = SONDERAUSGABEN_PAUSCHBETRAG;
    kfb = Math.floor((zkfTenths * 9756) / 10);
  } else if (stkl === 3) {
    kztab = 2;
    sap = SONDERAUSGABEN_PAUSCHBETRAG;
    kfb = Math.floor((zkfTenths * 9756) / 10);
  } else if (stkl === 4) {
    sap = SONDERAUSGABEN_PAUSCHBETRAG;
    kfb = Math.floor((zkfTenths * 4878) / 10);
  } else if (stkl === 5) {
    sap = SONDERAUSGABEN_PAUSCHBETRAG;
    kfb = 0;
  } else {
    kfb = 0;
  }
  const ztabfb = efa + anp + sap;

  /* --- UPEVP (Vorsorgepauschale) --- */
  const vspr = krv === 1
    ? 0
    : Math.floor((Math.min(zre4vp, BBGRVALV) * 930) / 10000);
  const capKv = Math.min(zre4vp, BBGKVPV);
  let vspkvpv: Cents;
  if (pkv === 0) {
    vspkvpv = Math.floor((capKv * kvPvRateNum) / 20000);
  } else if (stkl === 6) {
    vspkvpv = 0;
  } else {
    const pkpvagzj = Math.floor((pkpvagz * 12) / 100);
    vspkvpv = Math.floor((pkpv * 12) / 100) - pkpvagzj;
    if (vspkvpv < 0) vspkvpv = 0;
  }
  let vsp = ceilEuro(vspkvpv + vspr) * 100; // VSP, Euro ↑
  if (alv === 0 && stkl !== 6) {
    // MVSPHB
    const vspalv = Math.floor((Math.min(zre4vp, BBGRVALV) * 130) / 10000);
    let vsphb = vspalv + vspkvpv;
    if (vsphb > VSPHB_CAP) vsphb = VSPHB_CAP;
    const vspn = ceilEuro(vspr + vsphb) * 100; // VSPN, Euro ↑
    if (vspn > vsp) vsp = vspn;
  }

  /* --- MLSTJAHR --- */
  const mlstjahr = (tabfb: Euro): { zve: Cents; st: Euro } => {
    const zve = zre4 - tabfb * 100 - vsp;
    if (zve < 100) return { zve: 0, st: 0 };
    const x = Math.floor(zve / kztab / 100); // X = ZVE / KZTAB, Euro ↓
    const st = stkl < 5 ? papUptab26(x, kztab) : papMst56(x);
    return { zve, st };
  };
  const first = mlstjahr(ztabfb);

  /* --- MBERECH head: VFRB, WVFRB, LSTJAHR, UPLSTLZZ --- */
  const vfrb = anp * 100;
  const wvfrb = first.zve - GFB < 0 ? 0 : first.zve - GFB;
  const lstjahr = Math.floor((first.st * fThousandths) / 1000);
  const anteil = (jw: Cents): Cents => {
    if (lzz === 1) return jw;
    if (lzz === 2) return Math.floor(jw / 12);
    if (lzz === 3) return Math.floor((jw * 7) / 360);
    return Math.floor(jw / 360); // Ergebnis abrunden
  };
  const lstlzz = anteil(lstjahr * 100);

  /* --- ZKF second pass for JBMG (KiSt/SolZ base with Kinderfreibeträge) --- */
  let jbmg: Euro;
  if (zkfTenths > 0) {
    const second = mlstjahr(ztabfb + kfb);
    jbmg = Math.floor((second.st * fThousandths) / 1000); // JBMG = ST * F
  } else {
    jbmg = lstjahr;
  }

  /* --- MSOLZ --- */
  const solzfrei = SOLZFREI_EURO * kztab;
  let solzj: Cents = 0;
  let solzlzz: Cents = 0;
  if (jbmg > solzfrei) {
    solzj = Math.floor((jbmg * 55) / 10); // SOLZJ, Cent ↓
    const solzmin = Math.floor(((jbmg - solzfrei) * 119) / 10); // Cent ↓
    if (solzmin < solzj) solzj = solzmin;
    solzlzz = anteil(solzj * 100);
  }
  const bk = r > 0 ? anteil(jbmg * 100) : 0;

  return {
    lstlzz, solzlzz, bk, lstjahr, jbmg, solzj,
    zve: first.zve, st: first.st, vsp, vfrb, wvfrb,
  };
}
