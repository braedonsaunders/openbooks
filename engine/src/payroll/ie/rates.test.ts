/**
 * IE 2026 edition resolution: Jan–Sep vs Oct–Dec (PRSI Roadmap step), and a
 * hard refusal outside the transcribed calendar year.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ratesForPayDate } from "./rates.ts";

describe("IE 2026 edition resolution", () => {
  it("resolves the January edition up to 30 September", () => {
    assert.equal(ratesForPayDate("2026-01-01").edition, "2026-jan");
    assert.equal(ratesForPayDate("2026-09-30").edition, "2026-jan");
    assert.equal(ratesForPayDate("2026-09-30").prsiEmployeeRate, "0.042");
    assert.equal(ratesForPayDate("2026-09-30").prsiEmployerHigherRate, "0.1125");
  });

  it("resolves the October edition from 1 October (PRSI Roadmap step)", () => {
    assert.equal(ratesForPayDate("2026-10-01").edition, "2026-oct");
    assert.equal(ratesForPayDate("2026-12-31").edition, "2026-oct");
    assert.equal(ratesForPayDate("2026-10-01").prsiEmployeeRate, "0.0435");
    assert.equal(ratesForPayDate("2026-10-01").prsiEmployerLowerRate, "0.0915");
    assert.equal(ratesForPayDate("2026-10-01").prsiEmployerHigherRate, "0.114");
  });

  it("keeps PAYE and USC unchanged across the October step", () => {
    const jan = ratesForPayDate("2026-05-01");
    const oct = ratesForPayDate("2026-11-01");
    assert.equal(oct.payeStandardRate, jan.payeStandardRate);
    assert.equal(oct.payeHigherRate, jan.payeHigherRate);
    assert.deepEqual(oct.uscBands, jan.uscBands);
    assert.equal(oct.uscExemption, jan.uscExemption);
    assert.equal(oct.prsiCreditMax, jan.prsiCreditMax);
  });

  it("refuses any pay date outside 2026 instead of extrapolating", () => {
    assert.throws(() => ratesForPayDate("2025-12-31"), /no transcribed tables/);
    assert.throws(() => ratesForPayDate("2027-01-01"), /no transcribed tables/);
    assert.throws(() => ratesForPayDate("not-a-date"), /not an ISO date/);
  });
});
