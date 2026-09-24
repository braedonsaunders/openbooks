/**
 * DE computeStatutory wiring tests: a full monthly period computes end to
 * end, and every missing channel refuses BY NAME (no zero-KVZ default, no
 * Klasse-I assumption, no silent childlessness).
 *
 * Lohnsteuer/Soli/BK wiring is proven against the PAP engine direct (the PAP
 * itself is proven by the 516/516 Prüftabellen goldens in pap.test.ts); the
 * SV branches and KiSt carry hand-computed expectations in the comments.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cmp } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { buildResolution } from "../statutory-rates.ts";
import {
  computeDeStatutoryWithRates,
  DePayrollRefusal,
} from "./compute-statutory.ts";
import { computePapLaufend2026 } from "./pap.ts";
import { DE_PACK_RATES } from "./rates.ts";

type Pushed = { systemKey: string; kind: string; amount: string; sequence: number };

function fakeCtx(overrides: {
  income?: string;
  region?: string;
  nonPeriodic?: string;
  elstam?: Record<string, string | null> | null;
  pv?: Record<string, string | null> | null;
}): { ctx: PayrollStatutoryComputeContext; pushed: Pushed[] } {
  const pushed: Pushed[] = [];
  const elstam = overrides.elstam === undefined
    ? {
      steuerklasse: "I",
      kinderfreibetrag_anzahl: "0",
      konfession: null,
      freibetrag: "0",
      hinzurechnungsbetrag: "0",
      faktor: "1.000",
    }
    : overrides.elstam;
  const pv = overrides.pv === undefined
    ? { kinderlosenzuschlag: "true", abschlag_kinder: "0" }
    : overrides.pv;
  const ctx = {
    taxYear: 2026,
    income: overrides.income ?? "3000.00",
    nonPeriodic: overrides.nonPeriodic ?? "0",
    pensionable: overrides.income ?? "3000.00",
    insurable: overrides.income ?? "3000.00",
    periodsPerYear: 12,
    region: overrides.region ?? "NW",
    country: "DE",
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Emp",
    run: {},
    emp: {},
    filingAccountId: null,
    deduction: () => "0",
    pushStatutory: (systemKey: string, kind: "deduction" | "employer_contribution" | "credit", _desc: string, amount: string, sequence: number) => {
      // Like the real createPushStatutory: zero amounts never become lines.
      if (cmp(amount, "0") === 0) return;
      pushed.push({ systemKey, kind, amount, sequence });
    },
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
      const known = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"];
      if (!known.includes(region)) throw new PayrollPackError(`unknown region ${region}`);
    },
    employerLevies: {
      wcbAmount: "0", wcbAssessable: "0", ehtAmount: "0", ehtEarnings: "0",
      hsfAmount: "0", hsfEarnings: "0",
    },
    tx: {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, pushed };
}

const line = (pushed: Pushed[], systemKey: string, kind: string): string | null =>
  pushed.find((entry) => entry.systemKey === systemKey && entry.kind === kind)?.amount ?? null;

test("full monthly period computes: PAP wiring + hand-checked SV", () => {
  // €3,000, StKl I, KVZ 2.90, childless, no confession, NW.
  // Hand SV: KV 3000 × 8.75% = 262.50; RV 3000 × 9.3% = 279.00;
  // AV 3000 × 1.3% = 39.00; PV-AN 3000 × 2.4% = 72.00; PV-AG 3000 × 1.8% = 54.00.
  const { ctx, pushed } = fakeCtx({});
  const result = computeDeStatutoryWithRates(ctx, { kvz: 2.9 });
  const pap = computePapLaufend2026({
    lzz: 2, re4: 300000, stkl: 1, zkf: 0, af: 0, f: 1,
    alv: 0, krv: 0, pkv: 0, kvz: 2.9, pvs: 0, pvz: 1, pva: 0, r: 0,
    lzzfreib: 0, lzzhinzu: 0, pkpv: 0, pkpvagz: 0,
  });
  assert.equal(result.LST, (pap.lstlzz / 100).toFixed(4));
  assert.equal(result.SOLI, (pap.solzlzz / 100).toFixed(4));
  assert.equal(result.BK, (pap.bk / 100).toFixed(4));
  assert.equal(line(pushed, "lohnsteuer", "deduction"), result.LST);
  assert.equal(result.KV_W, "262.5000");
  assert.equal(result.KV_ER, "262.5000");
  assert.equal(result.RV_W, "279.0000");
  assert.equal(result.RV_ER, "279.0000");
  assert.equal(result.AV_W, "39.0000");
  assert.equal(result.AV_ER, "39.0000");
  assert.equal(result.PV_W, "72.0000");
  assert.equal(result.PV_ER, "54.0000");
  // No confession: no KiSt line at all (zero never becomes a line).
  assert.equal(line(pushed, "kirchenlohnsteuer", "deduction"), null);
  assert.equal(result.KIST, "0.0000");
});

test("ceilings cap the SV base; KiSt elected at 9% outside BY/BW", () => {
  // €7,000: KV/PV base capped at 5812.50 (5812.50 × 8.75% = 508.59 half-up);
  // RV/AV base capped at 8450 (no cap hit here: 7000 × 9.3% = 651.00).
  const { ctx, pushed } = fakeCtx({
    income: "7000.00",
    elstam: {
      steuerklasse: "I", kinderfreibetrag_anzahl: "0", konfession: "rk",
      freibetrag: "0", hinzurechnungsbetrag: "0", faktor: "1.000",
    },
  });
  const result = computeDeStatutoryWithRates(ctx, { kvz: 2.9 });
  assert.equal(result.KV_W, "508.5900");
  assert.equal(result.RV_W, "651.0000");
  assert.equal(result.PV_W, "139.5000"); // 5812.50 × 2.4%, PV rides the KV ceiling
  const pap = computePapLaufend2026({
    lzz: 2, re4: 700000, stkl: 1, zkf: 0, af: 0, f: 1,
    alv: 0, krv: 0, pkv: 0, kvz: 2.9, pvs: 0, pvz: 1, pva: 0, r: 1,
    lzzfreib: 0, lzzhinzu: 0, pkpv: 0, pkpvagz: 0,
  });
  const expectedKist = (Math.floor((pap.bk * 9) / 100) / 100).toFixed(4);
  assert.equal(result.KIST, expectedKist);
  assert.ok(Number(result.KIST) > 0, "confession set: KiSt accrues");
  assert.equal(line(pushed, "kirchenlohnsteuer", "deduction"), result.KIST);
});

test("Sachsen PV split and BY KiSt at 8%", () => {
  // BMG financing summary: https://www.bundesgesundheitsministerium.de/themen/pflege/online-ratgeber-pflege/die-pflegeversicherung/finanzierung
  // 2026 €3,000, not childless: 2.3% employee (€69), 1.3% employer (€39).
  // The 1-point employer-rate reduction moves each equal half by 0.5 points.
  const sn = fakeCtx({ region: "SN", pv: { kinderlosenzuschlag: "false", abschlag_kinder: "0" } });
  const snResult = computeDeStatutoryWithRates(sn.ctx, { kvz: 2.9 });
  assert.equal(snResult.PV_W, "69.0000");
  assert.equal(snResult.PV_ER, "39.0000");
  const snChildless = fakeCtx({ region: "SN", pv: { kinderlosenzuschlag: "true", abschlag_kinder: "0" } });
  const snChildlessResult = computeDeStatutoryWithRates(snChildless.ctx, { kvz: 2.9 });
  assert.equal(snChildlessResult.PV_W, "87.0000"); // +0.6 points, borne by employee
  assert.equal(snChildlessResult.PV_ER, "39.0000");
  const snDiscountedChildren = fakeCtx({ region: "SN", pv: { kinderlosenzuschlag: "false", abschlag_kinder: "2" } });
  const snDiscountedResult = computeDeStatutoryWithRates(snDiscountedChildren.ctx, { kvz: 2.9 });
  assert.equal(snDiscountedResult.PV_W, "54.0000"); // −0.25 points per eligible child
  assert.equal(snDiscountedResult.PV_ER, "39.0000");
  // BY confession: 8% of BK.
  const by = fakeCtx({
    region: "BY",
    elstam: {
      steuerklasse: "I", kinderfreibetrag_anzahl: "0", konfession: "ev",
      freibetrag: "0", hinzurechnungsbetrag: "0", faktor: "1.000",
    },
  });
  const byResult = computeDeStatutoryWithRates(by.ctx, { kvz: 2.9 });
  const pap = computePapLaufend2026({
    lzz: 2, re4: 300000, stkl: 1, zkf: 0, af: 0, f: 1,
    alv: 0, krv: 0, pkv: 0, kvz: 2.9, pvs: 0, pvz: 1, pva: 0, r: 1,
    lzzfreib: 0, lzzhinzu: 0, pkpv: 0, pkpvagz: 0,
  });
  assert.equal(byResult.KIST, (Math.floor((pap.bk * 8) / 100) / 100).toFixed(4));
});

test("missing KVZ refuses by name — never zero, never the average", () => {
  const { ctx } = fakeCtx({});
  assert.throws(
    () => computeDeStatutoryWithRates(ctx, { kvz: null }),
    (error: unknown) => {
      assert.ok(error instanceof DePayrollRefusal);
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /Zusatzbeitrag/);
      assert.match((error as Error).message, /de_kvz/);
      return true;
    },
  );
});

test("no ELStAM on file refuses; blank Steuerklasse refuses, not Klasse I", () => {
  const { ctx: noCert } = fakeCtx({ elstam: null });
  assert.throws(
    () => computeDeStatutoryWithRates(noCert, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof DePayrollRefusal);
      assert.match((error as Error).message, /ELStAM/);
      return true;
    },
  );
  const { ctx: noStkl } = fakeCtx({
    elstam: {
      steuerklasse: null, kinderfreibetrag_anzahl: "0", konfession: null,
      freibetrag: "0", hinzurechnungsbetrag: "0", faktor: "1.000",
    },
  });
  assert.throws(
    () => computeDeStatutoryWithRates(noStkl, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof DePayrollRefusal);
      assert.match((error as Error).message, /Steuerklasse I/);
      return true;
    },
  );
});

test("missing PV Kindernachweis refuses — never silent childlessness", () => {
  const { ctx } = fakeCtx({ pv: null });
  assert.throws(
    () => computeDeStatutoryWithRates(ctx, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof DePayrollRefusal);
      assert.match((error as Error).message, /de_pv_nachweis/);
      return true;
    },
  );
});

test("de_kvz resolves through the generic resolution (pure half)", () => {
  const decl = DE_PACK_RATES;
  const empty = buildResolution({ country: "DE", taxYear: 2026, pack: decl, rows: [], legacy: [] });
  assert.equal(empty.values("de_kvz"), null, "unconfigured: no values, so the engine refuses");
  const filled = buildResolution({
    country: "DE", taxYear: 2026, pack: decl, legacy: [],
    rows: [{
      id: "r1", country: "DE", rateKey: "de_kvz", region: null,
      filingAccountId: null, taxYear: 2026, values: { rate: "2.90" },
      supersededOn: null,
    }],
  });
  assert.deepEqual(filled.values("de_kvz"), { rate: "2.90" });
});

test("sonstige Bezüge still refused by name", () => {
  const { ctx } = fakeCtx({ nonPeriodic: "500.00" });
  assert.throws(
    () => computeDeStatutoryWithRates(ctx, { kvz: 2.9 }),
    (error: unknown) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match((error as Error).message, /sonstige Bezüge/);
      return true;
    },
  );
});
