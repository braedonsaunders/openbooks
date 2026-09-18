import assert from "node:assert/strict";
import test from "node:test";
// Side effect: publishes the built-in packs' filing sources, the same way any
// production importer of the pack registry does.
import "./payroll/packs.ts";
import { PAYROLL_COUNTRY_PACKS, PayrollPackError } from "./payroll/packs.ts";
import {
  declaredPayrollFilings,
  registerPayrollFilings,
  unregisterPayrollFilings,
  yearEndFiling,
} from "./payroll-filing-registry.ts";

/**
 * Every declared filing states its row-key grammar, and the subsidiary-scope
 * guard parses through it — no (country, filing) enumeration in generic code.
 * Pure: grammars are string functions, and these cases never reach a database.
 */

const EMP = "11111111-1111-1111-8111-111111111111";
const ACCT = "22222222-2222-2222-8222-222222222222";

test("every built-in filing declares a row-key grammar", () => {
  for (const pack of declaredPayrollFilings()) {
    if (!(pack.country in PAYROLL_COUNTRY_PACKS)) continue;
    for (const filing of pack.yearEnd) {
      assert.equal(
        typeof filing.parseRowId,
        "function",
        `${pack.country}/${filing.key} declares no parseRowId`,
      );
    }
  }
});

test("built-in row grammars round-trip their populations' keys", () => {
  assert.deepEqual(yearEndFiling("CA", "t4").parseRowId(`${EMP}:ON:${ACCT}`), {
    employees: [EMP],
    accounts: [ACCT],
  });
  assert.deepEqual(yearEndFiling("CA", "t4").parseRowId(`${EMP}:ON:`), {
    employees: [EMP],
    accounts: [],
  });
  assert.deepEqual(yearEndFiling("CA", "roe").parseRowId(EMP), {
    employees: [EMP],
    accounts: [],
  });
  assert.deepEqual(yearEndFiling("CA", "rl1").parseRowId(EMP), {
    employees: [EMP],
    accounts: [],
  });
  assert.deepEqual(yearEndFiling("US", "w2").parseRowId(`${EMP}:${ACCT}`), {
    employees: [EMP],
    accounts: [ACCT],
  });
  assert.deepEqual(yearEndFiling("US", "w2").parseRowId(`${EMP}:`), {
    employees: [EMP],
    accounts: [],
  });
  assert.deepEqual(yearEndFiling("US", "941").parseRowId(`${ACCT}:3`), {
    employees: [],
    accounts: [ACCT],
  });
  assert.deepEqual(yearEndFiling("US", "941").parseRowId(":3"), {
    employees: [],
    accounts: [],
  });
});

test("built-in row grammars refuse what their populations never build", () => {
  const cases: [string, string, string][] = [
    ["CA", "t4", "not-a-row"],
    ["CA", "t4", `${EMP}:ON`],
    ["CA", "t4", `${EMP}:ON:${ACCT}:extra`],
    ["CA", "t4", `nope:ON:${ACCT}`],
    ["CA", "t4", `${EMP}:ON:nope`],
    ["CA", "roe", `${EMP}:ON`],
    ["CA", "roe", ""],
    ["CA", "rl1", `${EMP}:${ACCT}`],
    ["US", "w2", EMP],
    ["US", "w2", `${EMP}:${ACCT}:extra`],
    ["US", "941", `${ACCT}:5`],
    ["US", "941", `${ACCT}:0`],
    ["US", "941", ACCT],
    ["US", "941", ""],
  ];
  for (const [country, key, rowId] of cases) {
    assert.equal(
      yearEndFiling(country, key).parseRowId(rowId),
      null,
      `${country}/${key} parsed ${JSON.stringify(rowId)}`,
    );
  }
});

test("a filing with no row-key grammar is refused at registration", () => {
  assert.throws(
    () =>
      registerPayrollFilings({
        country: "ZZ",
        programTypes: [],
        yearEnd: [{
          key: "x",
          label: "X",
          cadence: "annual",
          population: async () => ({ rowKey: "id", columns: [], rows: [] }),
          amendment: { supported: false, refusal: "no corrections here" },
          // Deliberately no parseRowId: the runtime assert (not the type
          // system) must refuse it, like the cadence-refusal doubles do.
        } as never],
      }),
    (error: Error) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match(error.message, /declares no row-key grammar/);
      return true;
    },
  );
  unregisterPayrollFilings("ZZ");
});
