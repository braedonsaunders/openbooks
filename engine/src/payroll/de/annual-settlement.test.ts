/**
 * DE annual settlement tests: the Lohnsteuer-Jahresausgleich (§42b EStG) for 2026.
 *
 * Proof layers, per the payroll-live bar:
 *
 * 1. Agency goldens: the annual Lohnsteuer figures come from the PAP 2026
 *    "Allgemeine maschinelle Jahreslohnsteuer 2026 (Prüftabelle)" (Anlage 1,
 *    pages 39–40 — the same table pap.test.ts transcribes cell for cell:
 *    40 000 € → Klasse I 4 407 €; 100 000 € → Klasse I 23 248 €, both under
 *    "Berechnet mit den Merkern ALV, KRV und PKV = 0 sowie KVZ = 2,90" with
 *    "In der Steuerklasse II gilt PVZ = 0, in den anderen Steuerklassen gilt
 *    PVZ = 1"). The settlement prices the year through the PAP's own annual
 *    (LZZ 1) path, so those cells are the expected annual figures directly.
 *    Solidaritätszuschlag and Kirchenlohnsteuer have no Prüftabelle; their
 *    expected values are hand-derived in the comments from the cited rules
 *    (SolZG §4: 5,5 % with 11,9 % Milderung; KiSt 8 % in BY/BW, 9 %
 *    elsewhere on the PAP BK base) applied to the TABLE's JBMG — for ZKF 0
 *    the JBMG equals the table's LSTJAHR, so no engine output enters the
 *    expectation.
 * 2. The settlement direction the statute allows: excess withholding is
 *    refunded as positive credits (the contract's money rule); a shortfall
 *    pushes NOTHING — §42b authorises a refund only (§42b Abs. 1 Satz 1,
 *    Abs. 2 Satz 4), and a post-year-end collection belongs to §41c, never
 *    to the Ausgleich (§41c Abs. 3 Satz 3). The shortfall test is the
 *    "collection case" made honest: it proves no collection line exists.
 * 3. Every refusal names its remedy: undeclared §42b facts, denied
 *    attestations, the Nr. 2/3a/3b certificate exclusions, a non-December
 *    pay date (§42b Abs. 3 Satz 1 timing), and the shared region gate.
 *
 * The withheld year-to-date figures are the test's chosen history (what the
 * generic layer reads back from committed stubs); the annual figures — and
 * hence every difference — are authority-derived.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettlementPush,
  missingSettlementInputs,
  resolveAnnualSettlement,
} from "../annual-settlement.ts";
import type { PayrollAnnualSettlementContext } from "../annual-settlement.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { computeDeStatutoryWithRates } from "./compute-statutory.ts";
import {
  computeDeSettlement,
  computeDeSettlementWithRates,
  deAnnualSettlement,
  DE_SETTLEMENT_FACTOR_KEYS,
  DE_SETTLEMENT_TAX_YEAR,
} from "./annual-settlement.ts";
import {
  DE_AUSGLEICH_GANZJAEHRIG,
  DE_AUSGLEICH_KEIN_AUSSCHLUSS,
  DE_AUSGLEICH_UNVERAENDERT,
} from "./employee-facts.ts";
import { DE_PAYROLL_PACK } from "./pack.ts";

type Pushed = { systemKey: string; kind: string; amount: string; sequence: number };

function fakeSettlement(overrides: {
  payDate?: string;
  region?: string;
  emp?: Record<string, string | null>;
  elstam?: Record<string, string | null> | null;
  pv?: Record<string, string | null> | null;
  ytdGross?: string;
  withheld?: Record<string, string>;
}): { ctx: PayrollAnnualSettlementContext; pushed: Pushed[] } {
  const pushed: Pushed[] = [];
  const pushSettlement = createSettlementPush((systemKey, kind, _desc, amount, sequence) => {
    pushed.push({ systemKey, kind, amount, sequence });
  });
  const elstam = overrides.elstam === undefined
    ? {
      steuerklasse: "I",
      kinderfreibetrag_anzahl: "0",
      konfession: null,
      freibetrag: "0.0000",
      hinzurechnungsbetrag: "0.0000",
      faktor: "1.000",
    }
    : overrides.elstam;
  const pv = overrides.pv === undefined
    ? { kinderlosenzuschlag: "true", abschlag_kinder: "0" }
    : overrides.pv;
  const ctx = {
    taxYear: 2026,
    country: "DE",
    region: overrides.region ?? "NW",
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test Employee",
    run: {},
    emp: overrides.emp ?? {
      [DE_AUSGLEICH_GANZJAEHRIG]: "true",
      [DE_AUSGLEICH_UNVERAENDERT]: "true",
      [DE_AUSGLEICH_KEIN_AUSSCHLUSS]: "true",
    },
    filingAccountId: null,
    periodsPerYear: 12,
    storedCertificates: [],
    certificateFor: (key: string) => {
      if (key === "de_elstam") {
        if (elstam == null) return null;
        return { certificate: {}, onFile: true, effectiveFrom: null, answers: elstam, missing: [] };
      }
      if (key === "de_pv_nachweis") {
        if (pv == null) return null;
        return { certificate: {}, onFile: true, effectiveFrom: null, answers: pv, missing: [] };
      }
      return null;
    },
    bool: (value: string | null | undefined) => value === "true",
    assertRegionSupported: (region: string) => {
      const known = [
        "BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV",
        "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH",
      ];
      if (!known.includes(region)) {
        throw new PayrollPackError(
          `Lohnsteuer withholding for ${region} is not implemented by the DE payroll pack.`,
        );
      }
    },
    employerLevies: {
      wcbAmount: "0", wcbAssessable: "0", ehtAmount: "0", ehtEarnings: "0",
      hsfAmount: "0", hsfEarnings: "0",
    },
    tx: {},
    payDate: overrides.payDate ?? "2026-12-31",
    priors: {
      ytdGross: overrides.ytdGross ?? "100000.0000",
      ytdWithheldBySystemKey: overrides.withheld ?? {},
    },
    pushSettlement,
  } as unknown as PayrollAnnualSettlementContext;
  return { ctx, pushed };
}

const credit = (pushed: Pushed[], systemKey: string): string | null =>
  pushed.find((entry) => entry.systemKey === systemKey && entry.kind === "credit")?.amount ?? null;

test("2026 declares the Jahresausgleich edition; every other year settles nothing", () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition, "2026 edition declared");
  assert.equal(edition.label, "Lohnsteuer-Jahresausgleich (§42b EStG)");
  assert.equal(edition.mode, "adjustment_line");
  assert.equal(edition.settlementSystemKey, "lohnsteuer");
  assert.deepEqual(
    [...edition.requiredEmployeeFacts],
    [DE_AUSGLEICH_GANZJAEHRIG, DE_AUSGLEICH_UNVERAENDERT, DE_AUSGLEICH_KEIN_AUSSCHLUSS],
  );
  assert.deepEqual([...edition.requiredCertificates], ["de_elstam", "de_pv_nachweis"]);
  assert.deepEqual([...edition.usesTenantRates], ["de_kvz"]);
  // The edition prices through the DB-backed entry point (rate resolution,
  // then the pure half every behavior test above exercises directly).
  assert.equal(edition.compute, computeDeSettlement);
  assert.equal(deAnnualSettlement(2025), null);
  assert.equal(deAnnualSettlement(2027), null);
  // The wiring check passes: lohnsteuer is a declared slot, so the remittance sees the lines.
  assert.deepEqual(resolveAnnualSettlement(DE_PAYROLL_PACK, 2026), edition);
  // The final-period gate cannot drift from the pack's own tax year ...
  assert.deepEqual(DE_SETTLEMENT_TAX_YEAR, DE_PAYROLL_PACK.taxYear);
  // ... and every factor the settlement returns is named in factorLabels.
  for (const key of DE_SETTLEMENT_FACTOR_KEYS) {
    assert.ok(DE_PAYROLL_PACK.factorLabels[key], `factor label for ${key}`);
  }
  assert.equal(resolveAnnualSettlement(DE_PAYROLL_PACK, 2025), null);
});

test("agency golden: 100000 Klasse I prices the refund (Prüftabelle 23248, hand Soli)", async () => {
  // Jahresbruttolohn 100 000 €, Klasse I, KVZ 2,90, PVZ 1 (childless), no
  // confession, NW. Prüftabelle: LSTJAHR 23 248 €. ZKF 0, so JBMG = 23 248.
  // Soli hand-derived (SolZG §4): 5,5 % × 23 248 = 1 278,64;
  // Milderung 11,9 % × (23 248 − 20 350) = 11,9 % × 2 898 = 344,862 → 344,86
  // (Cent ↓); the smaller wins: SOLZJ 344,86. KiSt base BK 0 (r = 0).
  // History withheld: LST 24 000,00, Soli 400,00 → refunds 752,00 and 55,14.
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx, pushed } = fakeSettlement({
    ytdGross: "100000.0000",
    withheld: { lohnsteuer: "24000.0000", solidaritaetszuschlag: "400.0000" },
  });
  const factors = await computeDeSettlementWithRates(ctx, { kvz: 2.9 });
  assert.equal(factors["JAHRESLST"], "23248.0000");
  assert.equal(factors["LST_AUSGLEICH"], "752.0000");
  assert.equal(factors["SOLI_AUSGLEICH"], "55.1400");
  assert.equal(factors["KIST_AUSGLEICH"], "0.0000");
  assert.equal(credit(pushed, "lohnsteuer"), "752.0000");
  assert.equal(credit(pushed, "solidaritaetszuschlag"), "55.1400");
  assert.equal(credit(pushed, "kirchenlohnsteuer"), null);
  for (const line of pushed) assert.ok(line.amount >= "0", "no negative push ever");
});

test("agency golden with confession: NW 9% versus BY 8% Kirchenlohnsteuer", async () => {
  // Same year as above, confession set: BK = JBMG = 23 248 €.
  // NW (9 %): floor(2 324 800 ct × 9 / 100) = 209 232 ct = 2 092,32.
  // BY (8 %): floor(2 324 800 ct × 8 / 100) = 185 984 ct = 1 859,84.
  // History withholds KiSt 2 200,00 in both → refunds 107,68 (NW) and 340,16 (BY).
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const elstam = {
    steuerklasse: "I",
    kinderfreibetrag_anzahl: "0",
    konfession: "ev",
    freibetrag: "0.0000",
    hinzurechnungsbetrag: "0.0000",
    faktor: "1.000",
  };
  const nw = fakeSettlement({
    region: "NW",
    elstam,
    ytdGross: "100000.0000",
    withheld: {
      lohnsteuer: "24000.0000",
      solidaritaetszuschlag: "400.0000",
      kirchenlohnsteuer: "2200.0000",
    },
  });
  const nwFactors = await computeDeSettlementWithRates(nw.ctx, { kvz: 2.9 });
  assert.equal(nwFactors["KIST_AUSGLEICH"], "107.6800");
  assert.equal(credit(nw.pushed, "kirchenlohnsteuer"), "107.6800");
  const by = fakeSettlement({
    region: "BY",
    elstam,
    ytdGross: "100000.0000",
    withheld: {
      lohnsteuer: "24000.0000",
      solidaritaetszuschlag: "400.0000",
      kirchenlohnsteuer: "2200.0000",
    },
  });
  const byFactors = await computeDeSettlementWithRates(by.ctx, { kvz: 2.9 });
  assert.equal(byFactors["KIST_AUSGLEICH"], "340.1600");
  assert.equal(credit(by.pushed, "kirchenlohnsteuer"), "340.1600");
});

test("shortfall settles nothing: §42b authorises a refund only, never a collection", async () => {
  // Jahresbruttolohn 40 000 €, Klasse I: Prüftabelle LSTJAHR 4 407 €.
  // History withheld only 4 000,00 — 407,00 short. §42b Abs. 2 Satz 4 refunds
  // the amount by which the annual tax FALLS SHORT of what was erhoben; a
  // shortfall is not collected here (§41c Abs. 3 Satz 3 reserves collection
  // to the Änderung des Lohnsteuerabzugs). Nothing pushes, factors read zero.
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx, pushed } = fakeSettlement({
    ytdGross: "40000.0000",
    withheld: { lohnsteuer: "4000.0000", solidaritaetszuschlag: "0.0000" },
  });
  const factors = await computeDeSettlementWithRates(ctx, { kvz: 2.9 });
  assert.equal(factors["JAHRESLST"], "4407.0000");
  assert.equal(factors["LST_AUSGLEICH"], "0.0000");
  assert.equal(factors["SOLI_AUSGLEICH"], "0.0000");
  assert.deepEqual(pushed, []);
});

test("exact match pushes nothing — the legitimate zero", async () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx, pushed } = fakeSettlement({
    ytdGross: "40000.0000",
    withheld: { lohnsteuer: "4407.0000", solidaritaetszuschlag: "0.0000" },
  });
  const factors = await computeDeSettlementWithRates(ctx, { kvz: 2.9 });
  assert.equal(factors["LST_AUSGLEICH"], "0.0000");
  assert.deepEqual(pushed, []);
});

test("per-line independence: an LST refund with a Soli shortfall pushes LST only", async () => {
  // MLST1224 floors each December difference at zero independently; the
  // Ausgleich does the same: Soli history 300,00 against annual 344,86 is a
  // shortfall (no line), while the LST excess still refunds.
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx, pushed } = fakeSettlement({
    ytdGross: "100000.0000",
    withheld: { lohnsteuer: "24000.0000", solidaritaetszuschlag: "300.0000" },
  });
  const factors = await computeDeSettlementWithRates(ctx, { kvz: 2.9 });
  assert.equal(factors["LST_AUSGLEICH"], "752.0000");
  assert.equal(factors["SOLI_AUSGLEICH"], "0.0000");
  assert.equal(credit(pushed, "lohnsteuer"), "752.0000");
  assert.equal(credit(pushed, "solidaritaetszuschlag"), null);
});

test("missing §42b facts refuse by name for the employee", async () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx } = fakeSettlement({ emp: {} });
  assert.deepEqual(missingSettlementInputs(edition, {
    emp: ctx.emp,
    certificateFor: ctx.certificateFor,
  }), [
    `employee fact ${DE_AUSGLEICH_GANZJAEHRIG}`,
    `employee fact ${DE_AUSGLEICH_UNVERAENDERT}`,
    `employee fact ${DE_AUSGLEICH_KEIN_AUSSCHLUSS}`,
  ]);
  await assert.rejects(
    () => computeDeSettlementWithRates(ctx, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError, "a pack refusal");
      assert.match(error.message, /Test Employee/);
      assert.match(error.message, new RegExp(DE_AUSGLEICH_GANZJAEHRIG));
      return true;
    },
  );
});

test("a denied attestation refuses as excluded, not as missing", async () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx } = fakeSettlement({
    emp: {
      [DE_AUSGLEICH_GANZJAEHRIG]: "false",
      [DE_AUSGLEICH_UNVERAENDERT]: "true",
      [DE_AUSGLEICH_KEIN_AUSSCHLUSS]: "true",
    },
  });
  await assert.rejects(
    () => computeDeSettlementWithRates(ctx, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match(error.message, /42b/);
      return true;
    },
  );
});

test("certificate exclusions refuse: Freibetrag (Nr. 3a), Faktor (Nr. 3b), current V/VI (Nr. 2)", async () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const base = {
    steuerklasse: "I",
    kinderfreibetrag_anzahl: "0",
    konfession: null,
    freibetrag: "0.0000",
    hinzurechnungsbetrag: "0.0000",
    faktor: "1.000",
  };
  for (
    const [name, elstam] of [
      ["Freibetrag", { ...base, freibetrag: "1000.0000" }],
      ["Hinzurechnungsbetrag", { ...base, hinzurechnungsbetrag: "500.0000" }],
      ["Faktorverfahren", { ...base, steuerklasse: "IV", faktor: "0.850" }],
      ["Steuerklasse V", { ...base, steuerklasse: "V" }],
      ["Steuerklasse VI", { ...base, steuerklasse: "VI" }],
    ] as const
  ) {
    const { ctx } = fakeSettlement({ elstam });
    await assert.rejects(() => computeDeSettlementWithRates(ctx, { kvz: 2.9 }), /42b/, name);
  }
});

test("missing certificates refuse: no ELStAM, no PV Nachweis", async () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const noElstam = fakeSettlement({ elstam: null });
  assert.deepEqual(
    missingSettlementInputs(edition, { emp: noElstam.ctx.emp, certificateFor: noElstam.ctx.certificateFor }),
    ["certificate de_elstam"],
  );
  await assert.rejects(() => computeDeSettlementWithRates(noElstam.ctx, { kvz: 2.9 }), /ELStAM/);
  const noPv = fakeSettlement({ pv: null });
  await assert.rejects(() => computeDeSettlementWithRates(noPv.ctx, { kvz: 2.9 }), /PV|Pflegeversicherung/);
});

test("only the final period settles: November refuses on §42b timing", async () => {
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const { ctx } = fakeSettlement({ payDate: "2026-11-30" });
  await assert.rejects(
    () => computeDeSettlementWithRates(ctx, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match(error.message, /42b.*Absatz 3|final period/i);
      return true;
    },
  );
});

test("the settlement never bypasses the region gate: where monthly refuses, it refuses", async () => {
  // Berlin (BE) is supported end to end in 2026 — the SVRV 2026 sets
  // bundeseinheitliche ceilings, so no Rechtskreis split runs through any
  // Land — and computes. An unscoped region refuses in BOTH passes through
  // the same ctx.assertRegionSupported gate.
  const edition = deAnnualSettlement(2026);
  assert.ok(edition);
  const be = fakeSettlement({
    region: "BE",
    ytdGross: "40000.0000",
    withheld: { lohnsteuer: "5000.0000" },
  });
  const beFactors = await computeDeSettlementWithRates(be.ctx, { kvz: 2.9 });
  assert.equal(beFactors["JAHRESLST"], "4407.0000");
  assert.equal(beFactors["LST_AUSGLEICH"], "593.0000");
  const scoped = fakeSettlement({ region: "XX" });
  await assert.rejects(() => computeDeSettlementWithRates(scoped.ctx, { kvz: 2.9 }), /XX/);
  const { ctx: monthlyCtx } = fakeSettlement({ region: "XX" });
  assert.throws(
    () =>
      computeDeStatutoryWithRates(
        { ...monthlyCtx, income: "3000.0000", nonPeriodic: "0", periodsPerYear: 12 } as never,
        { kvz: 2.9 },
      ),
    /XX/,
  );
});
