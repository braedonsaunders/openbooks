/**
 * JP year-end filing tests — the three statutory declarations and their
 * named refusals.
 *
 * The engine performs monthly 源泉徴収 only and does not perform 年末調整
 * (see JP_REFUSED_2026 in ./rates.ts), so a 源泉徴収票 reporting the
 * year-end-adjusted tax cannot be populated from committed runs: the
 * 年調年税額 the 源泉徴収税額 box asks for does not exist anywhere in the
 * product. These tests prove the pack refuses each filing BY NAME — naming
 * 年末調整 and the NTA remedy — instead of printing the sum of monthly
 * withholdings in a box that means adjusted tax.
 *
 * DB-free: every population refuses before any read, so no fixture can add
 * signal — the refusal fires identically with or without committed runs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import { jpPackFilings } from "./filings.ts";

test("JP year-end declares the three statutory filings, annual cadence", () => {
  const filings = jpPackFilings();
  assert.equal(filings.country, "JP");
  assert.deepEqual(filings.yearEnd.map((filing) => filing.key), [
    "gensenchoshu",
    "kyuyo_shiharai_hokokusho",
    "hotei_chosho_gokeihyo",
  ]);
  for (const filing of filings.yearEnd) {
    assert.equal(filing.cadence, "annual", filing.key);
    assert.equal(typeof filing.parseRowId, "function", filing.key);
    assert.equal(filing.slip, undefined, `${filing.key}: no slip without builders`);
  }
  const byKey = new Map(filings.yearEnd.map((filing) => [filing.key, filing]));
  assert.equal(byKey.get("gensenchoshu")?.label, "給与所得の源泉徴収票");
  assert.equal(byKey.get("kyuyo_shiharai_hokokusho")?.label, "給与支払報告書");
  assert.equal(
    byKey.get("hotei_chosho_gokeihyo")?.label,
    "給与所得の源泉徴収票等の法定調書合計表",
  );
});

test("every population refuses by name for the transcribed year 2026", async () => {
  const filings = jpPackFilings();
  assert.ok(filings.yearEnd.length > 0);
  for (const filing of filings.yearEnd) {
    await assert.rejects(
      filing.population("org", 2026),
      (error: unknown) => {
        assert.ok(error instanceof PayrollError, `${filing.key}: a PayrollError converts to populationRefusal`);
        assert.match((error as Error).message, /年末調整/, `${filing.key}: names the missing adjustment`);
        assert.match((error as Error).message, /年末調整のしかた/, `${filing.key}: names the NTA remedy`);
        return true;
      },
    );
  }
});

test("refusal holds for a year the tables do not cover, and 2024 names the 定額減税 interaction", async () => {
  const filings = jpPackFilings();
  for (const filing of filings.yearEnd) {
    await assert.rejects(filing.population("org", 2025), /年末調整/);
    await assert.rejects(
      filing.population("org", 2024),
      (error: unknown) => {
        assert.match((error as Error).message, /年末調整/);
        assert.match((error as Error).message, /定額減税/);
        return true;
      },
    );
  }
});

test("no row id parses while population refuses", () => {
  const filings = jpPackFilings();
  assert.ok(filings.yearEnd.length > 0);
  for (const filing of filings.yearEnd) {
    assert.equal(filing.parseRowId("anything"), null, filing.key);
    assert.equal(
      filing.parseRowId("3fa85f64-5717-4562-b3fc-2c963f66afa6"),
      null,
      filing.key,
    );
  }
});

test("download refusals name the exact unbuilt submission standard", () => {
  const byKey = new Map(jpPackFilings().yearEnd.map((filing) => [filing.key, filing]));
  assert.match(byKey.get("gensenchoshu")?.downloadRefusal ?? "", /e-Tax/);
  assert.match(byKey.get("kyuyo_shiharai_hokokusho")?.downloadRefusal ?? "", /eLTAX/);
  assert.match(byKey.get("hotei_chosho_gokeihyo")?.downloadRefusal ?? "", /e-Tax/);
});

test("amendments refuse with the real out-of-product remedy", () => {
  for (const filing of jpPackFilings().yearEnd) {
    assert.equal(filing.amendment.supported, false, filing.key);
    if (!filing.amendment.supported) {
      assert.match(filing.amendment.refusal, /再|訂正|resubmit/i, filing.key);
    }
  }
});
