/**
 * ES year-end filing declarations: row grammars, perception-key mapping and
 * amendment posture — pure, no database.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { esPackFilings, parseEs190RowId, parseEs111RowId } from "./es/filings.ts";
import {
  ES_190_PAYROLL_CLAVE,
  ES_190_UNSUPPORTED_CLAVES,
} from "./es/modelo-190.ts";

const EMP = "11111111-1111-1111-8111-111111111111";
const FOREIGN = "22222222-2222-2222-8222-222222222222";

test("ES declares the certificado (190, annual) and the 111 (quarterly)", () => {
  const filings = esPackFilings();
  assert.equal(filings.country, "ES");
  assert.deepEqual(
    filings.yearEnd.map((filing) => [filing.key, filing.cadence]),
    [["190", "annual"], ["111", "quarterly"]],
  );
  for (const filing of filings.yearEnd) {
    assert.equal(typeof filing.population, "function");
    assert.equal(typeof filing.parseRowId, "function");
    assert.ok(filing.slip, `${filing.key} owes the employee a slip`);
    assert.ok(
      typeof filing.downloadRefusal === "string" && filing.downloadRefusal.length > 0,
      `${filing.key} must name the submission standard it does not build`,
    );
    assert.ok(filing.amendment, `${filing.key} must declare its correction posture`);
  }
});

test("ES 190 rows are one employee plus province; 111 rows are one quarter", () => {
  assert.deepEqual(parseEs190RowId(`${EMP}:MD`), {
    employees: [EMP], accounts: [],
  });
  assert.deepEqual(parseEs111RowId("Q3"), { employees: [], accounts: [] });
});

test("ES row grammars refuse what their populations never build", () => {
  for (const bad of ["not-a-row", "", EMP, `${EMP}:MD:extra`, "MD", "Q5", "Q0", "q1", `${EMP}:Q1`]) {
    assert.equal(parseEs190RowId(bad), null, `190 must refuse ${bad}`);
  }
  for (const bad of ["not-a-row", "", EMP, `${EMP}:MD`, "Q5", "Q0", "q1", "1", "Trimestre 1"]) {
    assert.equal(parseEs111RowId(bad), null, `111 must refuse ${bad}`);
  }
  // The packs must not accept each other's rows either.
  assert.equal(parseEs190RowId("Q3"), null);
  assert.equal(parseEs111RowId(`${EMP}:MD`), null);
  assert.equal(parseEs190RowId(FOREIGN), null);
});

test("ordinary payroll classifies as Modelo 190 clave A with no subclave", () => {
  assert.equal(ES_190_PAYROLL_CLAVE.clave, "A");
  assert.equal(ES_190_PAYROLL_CLAVE.subclave, null);
  assert.ok(ES_190_PAYROLL_CLAVE.citation.includes("artículo 82"));
  // Every other clave is refused by name with its reason — never an empty slot.
  const refused = new Set(["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]);
  assert.deepEqual(new Set(ES_190_UNSUPPORTED_CLAVES.map((entry) => entry.clave)), refused);
  for (const entry of ES_190_UNSUPPORTED_CLAVES) {
    assert.ok(entry.reason.length > 20, `clave ${entry.clave} must name why payroll never files it`);
  }
});

test("ES correction posture: 190 sustitutiva/complementaria, 111 refused by name", () => {
  const filings = esPackFilings();
  const byKey = new Map(filings.yearEnd.map((filing) => [filing.key, filing]));
  const amendment190 = byKey.get("190")!.amendment;
  assert.equal(amendment190.supported, true);
  if (amendment190.supported) {
    assert.deepEqual([...amendment190.revisions], ["amended"]);
    assert.equal(amendment190.vehicle, "same_form");
    assert.ok((amendment190.formLabel ?? "").includes("complementaria"));
  }
  const amendment111 = byKey.get("111")!.amendment;
  assert.equal(amendment111.supported, false);
  if (!amendment111.supported) {
    assert.ok(
      amendment111.refusal.includes("complementaria"),
      "the 111 refusal must name the real out-of-product remedy",
    );
  }
});

test("Seguridad Social monthly settlement is refused by name, not declared", () => {
  const filings = esPackFilings();
  assert.ok(
    !filings.yearEnd.some((filing) => filing.key.includes("tgss") || filing.key.includes("rnt")),
    "no TGSS monthly filing may be declared",
  );
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["es_tgss_ccc"],
  );
});
