/**
 * DE Lohnsteuerbescheinigung (Ausdruck) — pure declaration tests.
 *
 * No database: the row grammar, the year gate, the per-box citations and
 * the pure slip renderer are all verifiable without one. The DB-owned
 * population (fixture, tie-out, refusal paths) lives in
 * filings.integration.test.ts and runs on the gate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOHNSTEUERBESCHEINIGUNG_CITATIONS,
  LOHNSTEUERBESCHEINIGUNG_GAPS,
  assertLohnsteuerbescheinigungYear,
  lohnsteuerbescheinigungSlipData,
  parseLohnsteuerbescheinigungRowId,
  type DeLohnsteuerbescheinigungSlip,
} from "./filings.ts";

const EMPLOYEE = "123e4567-e89b-12d3-a456-426614174000";
const OTHER = "123e4567-e89b-12d3-a456-426614174001";

test("row grammar is a bare employee id — the inverse of what population builds", () => {
  const scope = parseLohnsteuerbescheinigungRowId(EMPLOYEE);
  assert.deepEqual(scope, { employees: [EMPLOYEE], accounts: [] });
});

test("row grammar refuses everything that is not one of its rows", () => {
  assert.equal(parseLohnsteuerbescheinigungRowId("anything"), null);
  assert.equal(parseLohnsteuerbescheinigungRowId(""), null);
  // Foreign grammars — the W-2's employee:account and the T4's
  // employee:province:account — must not authorize a byte here.
  assert.equal(parseLohnsteuerbescheinigungRowId(`${EMPLOYEE}:${OTHER}`), null);
  assert.equal(parseLohnsteuerbescheinigungRowId(`${EMPLOYEE}:BY:${OTHER}`), null);
  assert.equal(parseLohnsteuerbescheinigungRowId(`${EMPLOYEE}:extra`), null);
  assert.equal(parseLohnsteuerbescheinigungRowId(` ${EMPLOYEE}`), null);
});

test("2026 is the only published Ausdruck year; any other year refuses by name", () => {
  assertLohnsteuerbescheinigungYear(2026);
  for (const year of [2024, 2025, 2027]) {
    assert.throws(
      () => assertLohnsteuerbescheinigungYear(year),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // Names the refused year, the only good year, and the filing.
        assert.ok(error.message.includes(String(year)), error.message);
        assert.ok(error.message.includes("2026"), error.message);
        assert.ok(/Lohnsteuerbescheinigung|Ausdruck/.test(error.message), error.message);
        return true;
      },
    );
  }
});

function sampleSlip(): DeLohnsteuerbescheinigungSlip {
  return {
    employeePartyId: EMPLOYEE,
    employeeName: "Maria Muster",
    land: "BY",
    steuerklasse: "I",
    faktor: null,
    kinderfreibetraege: "0",
    freibetragJahr: "0",
    hinzurechnungsbetragJahr: "0",
    konfession: "rk",
    zeitraumVon: "2026-01-01",
    zeitraumBis: "2026-02-28",
    finanzamt: "9143 · Betriebsstättenfinanzamt München",
    gross: "12400.00",
    lst: "1234.00",
    soli: "0.00",
    kist: "98.72",
    rvW: "1153.20",
    kvW: "604.50",
    pvW: "223.20",
    avW: "161.20",
    rvEr: "1153.20",
    kvEr: "604.50",
    pvEr: "223.20",
  };
}

test("the slip certifies withheld sums verbatim — no recomputation", () => {
  const slip = lohnsteuerbescheinigungSlipData(sampleSlip());
  const byCode = new Map(slip.boxes.map((box) => [box.code, box]));
  // Zeile 3/4/5/6: the certified core. Exact strings in, exact strings out.
  assert.equal(byCode.get("3")?.value, "12400.00");
  assert.equal(byCode.get("4")?.value, "1234.00");
  assert.equal(byCode.get("5")?.value, "0.00");
  assert.equal(byCode.get("6")?.value, "98.72");
  // Arbeitnehmeranteile Zeilen 23a/25/26/27 and Arbeitgeberanteile 22a/24a/24c.
  assert.equal(byCode.get("23a")?.value, "1153.20");
  assert.equal(byCode.get("25")?.value, "604.50");
  assert.equal(byCode.get("26")?.value, "223.20");
  assert.equal(byCode.get("27")?.value, "161.20");
  assert.equal(byCode.get("22a")?.value, "1153.20");
  assert.equal(byCode.get("24a")?.value, "604.50");
  assert.equal(byCode.get("24c")?.value, "223.20");
});

test("every printed box carries the Ausdruck's own Zeile citation", () => {
  const slip = lohnsteuerbescheinigungSlipData(sampleSlip());
  assert.ok(slip.boxes.length > 0);
  for (const box of slip.boxes) {
    const citation = (LOHNSTEUERBESCHEINIGUNG_CITATIONS as Record<string, { zeile: string; source: string }>)[box.code];
    assert.ok(citation, `Zeile ${box.code} (${box.label}) prints without a citation`);
    assert.ok(citation.source.includes("2026"), box.code);
    assert.ok(citation.zeile.includes(box.code.replace(/[a-z]/g, "")), box.code);
  }
});

test("the spouse church-tax line prints only bei Konfessionsverschiedenheit", () => {
  // No spouse share withheld: Zeile 7 is absent, never a zero the employer
  // would file as a real amount.
  const codes = lohnsteuerbescheinigungSlipData(sampleSlip()).boxes.map((box) => box.code);
  assert.ok(!codes.includes("7"), "Zeile 7 must be absent when nothing was withheld for a spouse");
});

test("ELStAM Merkmale print as declared facts, and the IdNr gap names its remedy", () => {
  const slip = lohnsteuerbescheinigungSlipData(sampleSlip());
  const headers = new Map(slip.headerFields.map((field) => [field.label, field.value]));
  assert.equal(headers.get("Steuerklasse/Faktor"), "I");
  assert.equal(headers.get("Zahl der Kinderfreibeträge"), "0");
  assert.equal(headers.get("Beschäftigungsland"), "BY");
  const idNr = headers.get("Steuerliche Identifikationsnummer (IdNr)");
  assert.ok(idNr, "the IdNr header must exist so it cannot be silently empty");
  assert.ok(/ELSTER/i.test(idNr), `the IdNr gap must name its remedy, got: ${idNr}`);
  // The scope note states what this printout does NOT cover.
  assert.ok(
    (slip.notes ?? []).some((note) => /Versorgungsbezüge|Progressionsvorbehalt/i.test(note)),
    "the slip face must state its scope limits",
  );
});

test("the Faktor prints for Steuerklasse IV Faktorverfahren", () => {
  const slip = lohnsteuerbescheinigungSlipData({
    ...sampleSlip(),
    steuerklasse: "IV",
    faktor: "0.850",
  });
  const headers = new Map(slip.headerFields.map((field) => [field.label, field.value]));
  assert.ok(
    (headers.get("Steuerklasse/Faktor") ?? "").includes("0.850"),
    "the Faktor is part of the certified Merkmale",
  );
});

test("unsupported Zeilen are declared gaps naming the Zeile, never silent", () => {
  assert.ok(LOHNSTEUERBESCHEINIGUNG_GAPS.length > 0);
  for (const gap of LOHNSTEUERBESCHEINIGUNG_GAPS) {
    // Every gap names its Zeile — except the IdNr gap, which is a header
    // block, not a Zeile, and names the identifier plus its remedy instead.
    const namesZeile = /Zeile \d/.test(gap);
    const namesIdNr = /IdNr/.test(gap) && /ELSTER/.test(gap);
    assert.ok(namesZeile || namesIdNr, `gap names neither a Zeile nor the IdNr remedy: ${gap}`);
  }
  const joined = LOHNSTEUERBESCHEINIGUNG_GAPS.join("\n");
  for (const zeile of ["2", "7", "8", "15", "16", "28"]) {
    assert.ok(joined.includes(`Zeile ${zeile}`), `Zeile ${zeile} is neither printed nor gapped`);
  }
});
