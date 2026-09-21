import assert from "node:assert/strict";
import test from "node:test";
import { IT_PACK_FILINGS } from "./filings.ts";
import {
  CU_SUPPORTED_TAX_YEAR,
  cuSlipBoxes,
  parseCuRowId,
  type CuSlip,
} from "./cu.ts";

/**
 * The IT Certificazione Unica declaration and its pure halves.
 *
 * DB-free by construction: the year-coverage refusals fire before any query
 * (so they run in the unit partition), and the box builder is pure. The
 * population tie-out lives in cu.integration.test.ts — "written to the
 * standard, not executed" on machines without a database.
 */

function cuFiling() {
  const filing = IT_PACK_FILINGS.yearEnd.find((entry) => entry.key === "cu");
  assert.ok(filing, "IT pack declares the cu filing");
  return filing;
}

test("the CU is an annual employee slip with a named e-file refusal", () => {
  const filing = cuFiling();
  assert.equal(filing.cadence, "annual");
  assert.equal(filing.label, "Certificazione Unica");
  assert.ok(filing.slip, "the employee-owed slip is declared");
  assert.match(filing.downloadRefusal ?? "", /Entratel/);
  assert.equal(filing.amendment.supported, false);
  assert.match(
    ("refusal" in filing.amendment && filing.amendment.refusal) || "",
    /Sostituzione/,
  );
});

test("the local row grammar agrees with the registry's UUID shape", async () => {
  // Parity, not drift: the local regex exists to avoid a module-evaluation
  // cycle, so this test pins it to the shape it mirrors. Imported here, in a
  // test the pack never loads — never in the builder itself.
  const { isFilingRowUuid } = await import("../filing-registry.ts");
  const samples = [
    "123e4567-e89b-12d3-a456-426614174000",
    "not-a-row-id",
    "",
    "123e4567-e89b-12d3-a456-426614174000:extra",
  ];
  for (const sample of samples) {
    assert.equal(
      (parseCuRowId(sample) !== null),
      isFilingRowUuid(sample),
      `grammar agrees on ${JSON.stringify(sample)}`,
    );
  }
});

test("the CU row grammar is a bare employee id, in both directions", () => {
  const employee = "123e4567-e89b-12d3-a456-426614174000";
  const scope = parseCuRowId(employee);
  assert.deepEqual(scope, { employees: [employee], accounts: [] });
  assert.equal(parseCuRowId("not-a-row-id"), null);
  assert.equal(parseCuRowId(`${employee}:extra`), null);
  assert.equal(parseCuRowId(""), null);
  // A foreign pack's account-scoped row is not a CU row.
  assert.equal(parseCuRowId(`${employee}:${employee}`), null);
});

test("population refuses a year without transcribed tables before any query", async () => {
  const filing = cuFiling();
  // 2024 lives on keep/payroll-it-priors, not in this tree: rates.ts carries
  // 2025 and 2026 only, and compute-statutory refuses anything else by name.
  await assert.rejects(
    filing.population("00000000-0000-0000-0000-000000000000", 2024),
    /no transcribed tables for tax year 2024/,
  );
});

test("population refuses 2026: the CU 2027 layout is not transcribed", async () => {
  const filing = cuFiling();
  // 2026 payroll computes, but the CU box set must come from that year's own
  // CU istruzioni (CU 2027, redditi 2026) — unpublished at transcription time
  // (tax-year-2026.ts says so) — so printing CU 2026 boxes would be a guess.
  await assert.rejects(
    filing.population("00000000-0000-0000-0000-000000000000", 2026),
    /CU 2027/,
  );
});

test("the 770 stays refused by name", async () => {
  const filing = IT_PACK_FILINGS.yearEnd.find((entry) => entry.key === "770");
  assert.ok(filing, "IT pack still declares the 770");
  assert.equal(filing.amendment.supported, false);
  await assert.rejects(
    filing.population("00000000-0000-0000-0000-000000000000", CU_SUPPORTED_TAX_YEAR),
    /Modello 770/,
  );
});

const BASE_SLIP: CuSlip = {
  employeePartyId: "123e4567-e89b-12d3-a456-426614174000",
  employeeName: "Mario Rossi",
  isFixedTerm: false,
  domicilioRegione: "Lazio",
  domicilioComune: "H501",
  redditi: "36000.00",
  ritenuteIrpef: "5200.00",
  addizionaleRegionale: "540.00",
  imponibileInps: "36000.00",
  contributiInpsWorker: "3308.40",
  trattamentoIntegrativo: "0.00",
  stubCount: 12,
};

test("an indeterminato slip certifies punto 1 with the fiscal core", () => {
  const boxes = cuSlipBoxes(BASE_SLIP);
  const byCode = new Map(boxes.map((box) => [box.code, box.value]));
  assert.equal(byCode.get("1"), "36000.00");
  assert.ok(!byCode.has("2"), "punto 2 is the determinato box, not a zero line");
  assert.equal(byCode.get("21"), "5200.00");
  assert.equal(byCode.get("22"), "540.00");
  assert.equal(byCode.get("INPS-4"), "36000.00");
  assert.equal(byCode.get("INPS-6"), "3308.40");
  assert.ok(!byCode.has("391"), "unpaid trattamento integrativo is omitted, never printed as zero");
});

test("a determinato slip certifies punto 2 instead of punto 1", () => {
  const boxes = cuSlipBoxes({ ...BASE_SLIP, isFixedTerm: true });
  const byCode = new Map(boxes.map((box) => [box.code, box.value]));
  assert.equal(byCode.get("2"), "36000.00");
  assert.ok(!byCode.has("1"), "punto 1 is the indeterminato box, not a zero line");
});

test("paid trattamento integrativo is certified at punto 391", () => {
  const boxes = cuSlipBoxes({ ...BASE_SLIP, trattamentoIntegrativo: "1200.00" });
  const byCode = new Map(boxes.map((box) => [box.code, box.value]));
  assert.equal(byCode.get("391"), "1200.00");
});
