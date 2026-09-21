import assert from "node:assert/strict";
import test from "node:test";
import { parsePit11RowId, pit11CorrectionSlip, pit11Dochod } from "./pit11.ts";
import { isFilingRowUuid, yearEndFiling } from "../filing-registry.ts";
import "../packs.ts";

/**
 * PIT-11 pure coverage: the row-key grammar both directions, the cited
 * poz. 31 derivation, and the korekta correction slip — none of which may
 * require a database. The end-to-end goldens (committed stubs → slip
 * boxes, to the grosz) live in pit11-tieout.integration.test.ts.
 */

const EMP = "11111111-1111-1111-8111-111111111111";
const ACCT = "22222222-2222-2222-8222-222222222222";

test("the PIT-11 row grammar is a bare employee id", () => {
  assert.deepEqual(parsePit11RowId(EMP), { employees: [EMP], accounts: [] });
});

test("the PIT-11 row grammar refuses what its population never builds", () => {
  for (const rowId of [
    "",
    "not-a-row",
    `${EMP}:PL`,
    `${EMP}:${ACCT}`,
    `${EMP}:PL:${ACCT}`,
    "nope-nope-nope-nope-nopenopenope",
  ]) {
    assert.equal(parsePit11RowId(rowId), null, `parsed ${JSON.stringify(rowId)}`);
  }
});

test("the local UUID copy agrees with the canonical helper on every shape", () => {
  // pit11.ts carries its own copy of the row-id UUID shape to stay out of
  // the packs import cycle (see the comment beside PIT11_ROW_UUID_RE). A
  // copy that drifts 404s real rows or admits foreign ones — so this pins
  // null-ness parity on a battery of realistic and adversarial strings.
  const cases = [
    EMP,
    EMP.toUpperCase(),
    "00000000-0000-0000-0000-000000000000",
    "",
    "not-a-row",
    `${EMP}:PL`,
    `${EMP}:${ACCT}`,
    "nope-nope-nope-nope-nopenopenope",
    EMP.slice(0, 35),
    `${EMP}0`,
    "11111111-1111-1111-8111-11111111111g",
  ];
  for (const rowId of cases) {
    assert.equal(
      parsePit11RowId(rowId) === null,
      !isFilingRowUuid(rowId),
      `parity broke on ${JSON.stringify(rowId)}`,
    );
  }
});

test("the declared filing parses through the same grammar", () => {
  const filing = yearEndFiling("PL", "pit11");
  assert.deepEqual(filing.parseRowId(EMP), { employees: [EMP], accounts: [] });
  assert.equal(filing.parseRowId(`${EMP}:${ACCT}`), null);
});

test("poz. 31 is przychód minus KUP — never revenue minus contributions", () => {
  // Anna's January: 8 000 brutto prices 1 096.80 of employee social
  // contributions, but poz. 31 is 8 000 − 250 (KUP), not 8 000 − 1 096.80.
  assert.equal(pit11Dochod("8000.0000", "250.0000"), "7750.0000");
  assert.equal(pit11Dochod("16000.0000", "500.0000"), "15500.0000");
  assert.equal(pit11Dochod("12000.0000", "500.0000"), "11500.0000");
});

test("a korekta restates only the boxes that moved, as-filed beside amended", async () => {
  const slip = await pit11CorrectionSlip({
    rowId: EMP,
    label: "Anna Kowalska",
    revision: "amended",
    previously: { fields: [], confidential: [] },
    current: {
      formCode: "PL_PIT11",
      formName: "PIT-11",
      headerFields: [{ label: "Employee (podatnik)", value: "Anna Kowalska" }],
      boxes: [],
    },
    changes: [
      { code: "33", label: "Zaliczka pobrana przez płatnika", previous: "990.0000", current: "996.0000", redacted: false },
      { code: null, label: "PESEL", previous: null, current: null, redacted: true },
    ],
  });
  assert.equal(slip.formNumber, "PIT-11");
  assert.match(slip.formName, /KOREKTA/);
  assert.deepEqual(slip.boxes, [
    { code: "33", label: "Zaliczka pobrana przez płatnika — as filed", value: "990.0000" },
    { code: "33", label: "Zaliczka pobrana przez płatnika — amended", value: "996.0000", emphasis: true },
  ]);
  assert.ok(
    slip.headerFields.some((field) => field.label === "Cel złożenia (poz. 7)" && field.value === "2 — korekta informacji"),
    "the korekta marks poz. 7 option 2",
  );
});

test("a korekta restating the same figures is refused, not filed", async () => {
  await assert.rejects(
    () =>
      pit11CorrectionSlip({
        rowId: EMP,
        label: "Anna Kowalska",
        revision: "amended",
        previously: { fields: [], confidential: [] },
        current: { formCode: "PL_PIT11", formName: "PIT-11", headerFields: [], boxes: [] },
        changes: [],
      }),
    /nothing on .* changed/,
  );
});
