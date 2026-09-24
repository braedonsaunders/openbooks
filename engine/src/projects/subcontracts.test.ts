import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  SubcontractError,
  addSubcontractSovLine,
  approveSubcontractChangeOrder,
  computeVendorApplication,
  createSubcontract,
  createSubcontractChangeOrder,
  createSubcontractPaymentControl,
  createVendorPayApplication,
  parseSubcontractTransitionAction,
  releaseVendorRetainage,
  revisedSubcontractSovValue,
  updateDraftSubcontract,
  updateVendorPayApplicationLines,
} from "./subcontracts.ts";
import { db } from "../platform/db.ts";

test("subcontract transition parser is strict and runs before transaction work", () => {
  for (const action of ["substantially_complete", "close", "void"] as const) {
    assert.equal(parseSubcontractTransitionAction(action), action);
  }

  for (const invalid of [
    "approve",
    "",
    "void ",
    undefined,
    null,
    42,
    { action: "void" },
    ["void"],
  ]) {
    assert.throws(
      () => parseSubcontractTransitionAction(invalid),
      (error) => error instanceof SubcontractError && error.message === "Invalid subcontract transition action",
    );
  }

  const source = readFileSync(new URL("./subcontracts.ts", import.meta.url), "utf8");
  const transitionStart = source.indexOf("export async function transitionSubcontract");
  const transactionStart = source.indexOf("await db.transaction", transitionStart);
  const parserStart = source.indexOf(
    "const action = parseSubcontractTransitionAction(input.action)",
    transitionStart,
  );
  assert.ok(transitionStart >= 0, "transitionSubcontract is defined");
  assert.ok(parserStart >= 0 && parserStart < transactionStart, "transition validation precedes transaction work");
});

test("vendor application treats stored materials as a cumulative balance", () => {
  const result = computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "1000",
    previousEarned: "400",
    previousMaterialsStored: "100",
    workCompletedThisPeriod: "150",
    materialsStoredCurrent: "50",
    retainagePercent: "10",
  }]);
  assert.deepEqual(result, {
    lines: [{
      sovLineId: "line-1",
      grossThisPeriod: "100.0000",
      retainageThisPeriod: "10.0000",
      netDue: "90.0000",
      earnedToDate: "500.0000",
      materialsStoredCurrent: "50.0000",
      remainingCommitment: "500.0000",
    }],
    grossThisPeriod: "100.0000",
    retainageThisPeriod: "10.0000",
    netDue: "90.0000",
  });
});
test("vendor two-decimal settlement rounds the cumulative retained amount and carries the residual", () => {
  const result = computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "10000",
    previousEarned: "0",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "3333.33",
    materialsStoredCurrent: "0",
    retainagePercent: "10",
  }, {
    sovLineId: "line-2",
    scheduledValue: "10000",
    previousEarned: "0",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "3333.33",
    materialsStoredCurrent: "0",
    retainagePercent: "5",
  }], { minorUnits: 2 });
  // Exact 333.333 + 166.6665 settles 333.33 + 166.67 = 500.00 exactly.
  assert.equal(result.lines[0]!.retainageThisPeriod, "333.3300");
  assert.equal(result.lines[1]!.retainageThisPeriod, "166.6700");
  assert.equal(result.retainageThisPeriod, "500.0000");
  assert.equal(result.netDue, "6166.6600");
});

test("vendor prior-draw replay carries the residual across draws", () => {
  const result = computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "10000",
    previousEarned: "333.33",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "333.33",
    materialsStoredCurrent: "0",
    retainagePercent: "10",
  }], { minorUnits: 2, priorExactRetainage: ["33.3333"] });
  // Cumulative exact 66.6666 rounds to 66.67; 33.33 already settled.
  assert.equal(result.retainageThisPeriod, "33.3400");
  assert.equal(result.lines[0]!.earnedToDate, "666.6600");
});

test("vendor application prevents stored-material double pay and overbilling", () => {
  assert.throws(() => computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "1000",
    previousEarned: "400",
    previousMaterialsStored: "100",
    workCompletedThisPeriod: "25",
    materialsStoredCurrent: "50",
    retainagePercent: "10",
  }]), /reduction in stored materials must be offset/);
  assert.throws(() => computeVendorApplication([{
    sovLineId: "line-1",
    scheduledValue: "450",
    previousEarned: "400",
    previousMaterialsStored: "0",
    workCompletedThisPeriod: "51",
    materialsStoredCurrent: "0",
    retainagePercent: "10",
  }]), /exceeds the revised SOV value/);
});

test("deductive change cannot erase earned work", () => {
  assert.equal(revisedSubcontractSovValue("1000", "-200", "750"), "800.0000");
  assert.equal(revisedSubcontractSovValue("1000.00", "-200.0000", "750"), "800.0000");
  assert.throws(
    () => revisedSubcontractSovValue("1000", "-300", "750"),
    SubcontractError,
  );
  assert.throws(
    () => revisedSubcontractSovValue("not-a-number", "-200", "750"),
    SubcontractError,
  );
  assert.throws(
    () => revisedSubcontractSovValue("1000", "-200", "0.00005"),
    SubcontractError,
  );
});

test("subcontract dates are validated as calendar days before any database work", async (t) => {
  const transactionDb = db as unknown as { transaction(callback: unknown): Promise<unknown> };
  t.mock.method(transactionDb, "transaction", async () => {
    throw new Error("database work must not start for an invalid date");
  });
  const isDateError = (error: unknown) =>
    error instanceof SubcontractError && /valid calendar date/.test(error.message);
  const base = { orgId: "org-1", userId: "user-1", subcontractId: "sub-1" };
  // The route stringifies a missing approvedOn to "undefined"; that must be a
  // domain rejection, not a 22007 from the date column.
  await assert.rejects(approveSubcontractChangeOrder("org-1", "user-1", "co-1", "undefined"), isDateError);
  for (const bad of ["", "2026-02-30", "07/31/2026", "2026-7-1"]) {
    await assert.rejects(approveSubcontractChangeOrder("org-1", "user-1", "co-1", bad), isDateError, `approve(${bad})`);
    await assert.rejects(releaseVendorRetainage({ ...base, periodEnd: bad, amount: "100" }), isDateError, `release(${bad})`);
    await assert.rejects(createVendorPayApplication({ ...base, periodEnd: bad }), isDateError, `application(${bad})`);
    await assert.rejects(
      createSubcontractPaymentControl({ ...base, controlType: "payment_hold", reason: "Lien notice", effectiveOn: bad }),
      isDateError,
      `control effectiveOn(${bad})`,
    );
    // Optional dates: empty means "not set"; anything else must be a calendar day.
    if (bad === "") continue;
    await assert.rejects(
      createSubcontractPaymentControl({ ...base, controlType: "payment_hold", reason: "Lien notice", effectiveOn: "2026-07-01", expiresOn: bad }),
      isDateError,
      `control expiresOn(${bad})`,
    );
    await assert.rejects(
      createSubcontract({ ...base, projectId: "p-1", vendorId: "v-1", number: "S-1", title: "Roofing", originalCommitment: "1000", startsOn: bad }),
      isDateError,
      `subcontract startsOn(${bad})`,
    );
  }
});

/** Flatten a drizzle SQL chunk into raw text for lock-keyword assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}

type FakeTx = { execute: (query: unknown) => Promise<{ rows: Record<string, unknown>[] }> };

function mockTransaction(t: TestContext, features: Record<string, boolean>, seen: string[]): void {
  const tx: FakeTx = {
    execute: async (query: unknown) => {
      seen.push(sqlText(query));
      return { rows: [{ features }] };
    },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: FakeTx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: FakeTx) => Promise<unknown>) => callback(tx),
  );
}

const subcontractInput = {
  orgId: "org-1",
  userId: "user-1",
  projectId: "p-1",
  vendorId: "v-1",
  number: "S-1",
  title: "Roofing",
  originalCommitment: "1000",
};

test("createSubcontract takes the fence and rechecks both gates under shared row locks", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: true, subcontracts: false }, seen);
  // The refusal names the gate. A concurrent disable commits first, so the
  // new subcontract must be refused, never committed hidden behind the gate.
  await assert.rejects(
    createSubcontract(subcontractInput),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Subcontracts feature is disabled",
  );
  // Fence first, then both gates rechecked before any other database work:
  // the advisory lock serializes against the disable path's blocker checks
  // and each fenced read's shared org-row lock against its exclusive one.
  assert.equal(seen.length, 3);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  for (const text of seen.slice(1)) {
    assert.match(text, /from orgs/);
    assert.match(text, /for share/);
  }
});

test("createSubcontract refuses a disabled Projects parent gate first", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: false, subcontracts: true }, seen);
  await assert.rejects(
    createSubcontract(subcontractInput),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Projects feature is disabled",
  );
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /for share/);
});

test("createSubcontract proceeds past enabled gates to the project lookup", async (t) => {
  let calls = 0;
  const tx: FakeTx = {
    execute: async () => {
      calls += 1;
      if (calls === 1) return { rows: [] };
      if (calls <= 3) return { rows: [{ features: { projects: true, subcontracts: true } }] };
      throw new Error("beyond-gate");
    },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: FakeTx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: FakeTx) => Promise<unknown>) => callback(tx),
  );
  // Enabled gates must not refuse: the flow continues to the next check.
  await assert.rejects(createSubcontract(subcontractInput), /beyond-gate/);
});

test("createVendorPayApplication shares the same fenced gate", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: true, subcontracts: false }, seen);
  await assert.rejects(
    createVendorPayApplication({ orgId: "org-1", userId: "user-1", subcontractId: "s-1", periodEnd: "2026-08-31" }),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Subcontracts feature is disabled",
  );
  assert.ok(seen.length >= 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /for share/);
});

test("addSubcontractSovLine shares the same fenced gate", async (t) => {
  const seen: string[] = [];
  mockTransaction(t, { projects: false, subcontracts: false }, seen);
  await assert.rejects(
    addSubcontractSovLine({ orgId: "org-1", userId: "user-1", subcontractId: "s-1", description: "Demolition", scheduledValue: "500" }),
    (error: unknown) =>
      error instanceof SubcontractError && error.message === "Projects feature is disabled",
  );
  assert.ok(seen.length >= 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /for share/);
});

/* ------------------------------------------------------------------ */
/* Money inputs fail closed before any database work                    */
/* ------------------------------------------------------------------ */

/**
 * Every subcontract money input runs through canonicalDecimal then
 * normalizeMoney and refuses unreadable values with a field-naming
 * SubcontractError before any transaction opens. The tables below drive
 * the real entry points: malformed values never reach the mocked
 * transaction, while valid ones sail through the money gate and die at
 * the disabled feature gate instead.
 */

/** Values canonicalDecimal(4) refuses: separators, symbols, scale, science, blanks, nullish. */
const MALFORMED_MONEY: unknown[] = ["12,34", "1,234", "1.23456", "$100", "\u20ac50", "1e3", "abc", "", "   ", null, undefined];
/** Optional fields that default on nullish (never reach the parser). */
const MALFORMED_MONEY_PRESENT: unknown[] = ["12,34", "1,234", "1.23456", "$100", "\u20ac50", "1e3", "abc", "", "   "];
/** Optional fields that also skip on blank (never reach the parser). */
const MALFORMED_MONEY_NONBLANK: unknown[] = ["12,34", "1,234", "1.23456", "$100", "\u20ac50", "1e3", "abc", "   "];

/** Valid money passes the money gate and dies at the disabled feature gate. */
async function passesMoneyGate(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof SubcontractError && error.message === "Projects feature is disabled",
  );
}

test("createSubcontract refuses unreadable commitment money before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  for (const bad of MALFORMED_MONEY) {
    await assert.rejects(
      createSubcontract({ ...subcontractInput, originalCommitment: bad as string }),
      /original commitment must be an exact decimal/,
      `commitment ${String(bad)}`,
    );
  }
  for (const bad of MALFORMED_MONEY_PRESENT) {
    await assert.rejects(
      createSubcontract({ ...subcontractInput, defaultRetainagePercent: bad as string }),
      /default retainage percent must be an exact decimal/,
      `retainage ${String(bad)}`,
    );
  }
  await passesMoneyGate(createSubcontract(subcontractInput));
});

test("updateDraftSubcontract refuses unreadable commitment money before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  const base = { orgId: "org-1", userId: "user-1", id: "s-1", title: "Roofing", originalCommitment: "1000", defaultRetainagePercent: "10" };
  for (const bad of MALFORMED_MONEY) {
    await assert.rejects(
      updateDraftSubcontract({ ...base, originalCommitment: bad as string }),
      /original commitment must be an exact decimal/,
      `commitment ${String(bad)}`,
    );
  }
  for (const bad of MALFORMED_MONEY_PRESENT) {
    await assert.rejects(
      updateDraftSubcontract({ ...base, defaultRetainagePercent: bad as string }),
      /default retainage percent must be an exact decimal/,
      `retainage ${String(bad)}`,
    );
  }
  await passesMoneyGate(updateDraftSubcontract(base));
});

test("addSubcontractSovLine refuses unreadable line money before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  const base = { orgId: "org-1", userId: "user-1", subcontractId: "s-1", description: "Demolition", scheduledValue: "500" };
  for (const bad of MALFORMED_MONEY) {
    await assert.rejects(
      addSubcontractSovLine({ ...base, scheduledValue: bad as string }),
      /scheduled value must be an exact decimal/,
      `scheduled ${String(bad)}`,
    );
  }
  for (const bad of MALFORMED_MONEY_NONBLANK) {
    await assert.rejects(
      addSubcontractSovLine({ ...base, retainagePercent: bad as string }),
      /retainage percent must be an exact decimal/,
      `retainage ${String(bad)}`,
    );
  }
  await passesMoneyGate(addSubcontractSovLine(base));
});

test("createSubcontractChangeOrder refuses unreadable amounts before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  const base = { orgId: "org-1", userId: "user-1", subcontractId: "s-1", number: "CO-1", amount: "500" };
  for (const bad of MALFORMED_MONEY) {
    await assert.rejects(
      createSubcontractChangeOrder({ ...base, amount: bad as string }),
      /change order amount must be an exact decimal/,
      `amount ${String(bad)}`,
    );
  }
  await passesMoneyGate(createSubcontractChangeOrder(base));
});

test("releaseVendorRetainage refuses unreadable amounts before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  const base = { orgId: "org-1", userId: "user-1", subcontractId: "s-1", periodEnd: "2026-07-31", amount: "100" };
  for (const bad of MALFORMED_MONEY) {
    await assert.rejects(
      releaseVendorRetainage({ ...base, amount: bad as string }),
      /retainage release amount must be an exact decimal/,
      `amount ${String(bad)}`,
    );
  }
  await passesMoneyGate(releaseVendorRetainage(base));
});

test("createSubcontractPaymentControl refuses unreadable limits before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  const base = {
    orgId: "org-1", userId: "user-1", subcontractId: "s-1",
    controlType: "payment_hold" as const, reason: "Hold", effectiveOn: "2026-07-31", amountLimit: "500",
  };
  for (const bad of MALFORMED_MONEY_NONBLANK) {
    await assert.rejects(
      createSubcontractPaymentControl({ ...base, amountLimit: bad as string }),
      /amount limit must be an exact decimal/,
      `limit ${String(bad)}`,
    );
  }
  await passesMoneyGate(createSubcontractPaymentControl(base));
});

test("computeVendorApplication refuses unreadable line money", () => {
  const line = {
    sovLineId: "line-1", scheduledValue: "10000", previousEarned: "0",
    previousMaterialsStored: "0", workCompletedThisPeriod: "3333.33",
    materialsStoredCurrent: "0", retainagePercent: "10",
  };
  const cases: Array<{ field: string; message: RegExp }> = [
    { field: "previousEarned", message: /previous earned must be an exact decimal/ },
    { field: "previousMaterialsStored", message: /previous materials stored must be an exact decimal/ },
    { field: "workCompletedThisPeriod", message: /work completed this period must be an exact decimal/ },
    { field: "materialsStoredCurrent", message: /materials stored current must be an exact decimal/ },
    { field: "retainagePercent", message: /retainage percent must be an exact decimal/ },
  ];
  for (const { field, message } of cases) {
    for (const bad of MALFORMED_MONEY) {
      assert.throws(
        () => computeVendorApplication([{ ...line, [field]: bad as string }]),
        (error: unknown) => error instanceof SubcontractError && message.test(error.message),
        `${field} ${String(bad)}`,
      );
    }
  }
});

test("updateVendorPayApplicationLines refuses unreadable line money before any database work", async (t) => {
  mockTransaction(t, { projects: false }, []);
  const line = (work: unknown, stored: unknown) => ({
    sovLineId: randomUUID(), workCompletedThisPeriod: work as string, materialsStoredCurrent: stored as string,
  });
  const base = { orgId: "org-1", userId: "user-1", payApplicationId: "app-1", expectedRevision: 1 };
  for (const bad of MALFORMED_MONEY) {
    await assert.rejects(
      updateVendorPayApplicationLines({ ...base, lines: [line(bad, "0")] }),
      /work completed this period must be an exact decimal/,
      `work ${String(bad)}`,
    );
    await assert.rejects(
      updateVendorPayApplicationLines({ ...base, lines: [line("100", bad)] }),
      /materials stored current must be an exact decimal/,
      `stored ${String(bad)}`,
    );
  }
  await passesMoneyGate(updateVendorPayApplicationLines({ ...base, lines: [line("100", "0")] }));
});

test("revisedSubcontractSovValue refuses unreadable inputs", () => {
  const cases: Array<{ args: (bad: unknown) => [unknown, unknown, unknown]; message: RegExp; label: string }> = [
    { args: (bad) => [bad, "-200", "750"], message: /current scheduled value must be an exact decimal/, label: "scheduled" },
    { args: (bad) => ["1000", bad, "750"], message: /change amount must be an exact decimal/, label: "change" },
    { args: (bad) => ["1000", "-200", bad], message: /earned to date must be an exact decimal/, label: "earned" },
  ];
  for (const { args, message, label } of cases) {
    for (const bad of MALFORMED_MONEY) {
      const [a, b, c] = args(bad);
      assert.throws(
        () => revisedSubcontractSovValue(a as string, b as string, c as string),
        (error: unknown) => error instanceof SubcontractError && message.test(error.message),
        `${label} ${String(bad)}`,
      );
    }
  }
});
