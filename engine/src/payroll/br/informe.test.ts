/**
 * BR informe tests that need no database: the row-key grammar, the
 * per-year reporting-channel rule, the transcribed-year guard, and the
 * filing declaration itself.
 *
 * Run with `node --import tsx` on this file.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { brPackFilings } from "./filings.ts";
import {
  assertBrInformeYearSupported,
  brDependenteValue,
  brInformeChannelNote,
  brInformeYears,
  parseBrInformeRowId,
} from "./informe.ts";

const ALICE = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";

test("parseRowId round-trips every row id the population emits", () => {
  assert.deepEqual(parseBrInformeRowId(`${ALICE}:${ACCOUNT}`), {
    employees: [ALICE],
    accounts: [ACCOUNT],
  });
  assert.deepEqual(parseBrInformeRowId(`${ALICE}:`), {
    employees: [ALICE],
    accounts: [],
  });
});

test("parseRowId returns null for anything that is not one of its rows", () => {
  assert.equal(parseBrInformeRowId("not-a-row"), null);
  assert.equal(parseBrInformeRowId(`${ALICE}:${ACCOUNT}:extra`), null);
  assert.equal(parseBrInformeRowId(`:${ACCOUNT}`), null);
  assert.equal(parseBrInformeRowId(`${ALICE}:not-a-uuid`), null);
  // A foreign pack's grammar (the T4's employee:province:account triple)
  // is not a BR row, so the guard cannot authorise a byte of it here.
  assert.equal(parseBrInformeRowId(`${ALICE}:ON:${ACCOUNT}`), null);
});

test("the informe covers exactly the transcribed years 2024–2026", () => {
  assert.deepEqual(brInformeYears(), [2024, 2025, 2026]);
  for (const year of [2024, 2025, 2026]) {
    assertBrInformeYearSupported(year);
  }
  assert.throws(() => assertBrInformeYearSupported(2023), /2023.*has not been transcribed/);
  assert.throws(() => assertBrInformeYearSupported(2027), /2027.*has not been transcribed/);
});

test("the dependent deduction value comes off the year's own module", () => {
  assert.equal(brDependenteValue(2024), "189.59");
  assert.equal(brDependenteValue(2025), "189.59");
  assert.equal(brDependenteValue(2026), "189.59");
});

test("2024 reports through DIRF; 2025+ through eSocial + EFD-Reinf", () => {
  assert.match(brInformeChannelNote(2024), /DIRF/);
  assert.doesNotMatch(brInformeChannelNote(2024), /extinta/);
  for (const year of [2025, 2026]) {
    const note = brInformeChannelNote(year);
    assert.match(note, /eSocial/);
    assert.match(note, /EFD-Reinf/);
    assert.match(note, /DIRF/);
    assert.match(note, /extinta/);
  }
});

test("the BR pack declares the informe as its annual filing", () => {
  const filings = brPackFilings();
  assert.deepEqual(filings.yearEnd.map((filing) => filing.key), ["informe"]);
  const informe = filings.yearEnd[0]!;
  assert.equal(informe.cadence, "annual");
  assert.equal(
    informe.label,
    "Comprovante de Rendimentos Pagos e de Imposto sobre a Renda Retido na Fonte",
  );
  assert.equal(typeof informe.parseRowId, "function");
  assert.equal(typeof informe.population, "function");
  assert.ok(informe.slip, "the employee is owed the statement itself");
  // eSocial, EFD-Reinf and DCTFWeb are out of scope as submission
  // standards: the refusal names every one of them.
  assert.ok(!informe.download, "no electronic file is built");
  assert.match(informe.downloadRefusal ?? "", /eSocial/);
  assert.match(informe.downloadRefusal ?? "", /EFD-Reinf/);
  assert.match(informe.downloadRefusal ?? "", /DCTFWeb/);
  // A wrong comprovante is corrected by re-issuing it; the event
  // retification behind it is named, never built.
  assert.equal(informe.amendment.supported, true);
  if (informe.amendment.supported) {
    assert.deepEqual([...informe.amendment.revisions], ["amended"]);
    assert.equal(informe.amendment.vehicle, "same_form");
    assert.match(informe.amendment.downloadRefusal ?? "", /eSocial/);
  }
});
