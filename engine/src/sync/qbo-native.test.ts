import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNativeFromQbo,
  isQboVoided,
  qboVoidNote,
  type QboTxn,
} from "./qbo-native.ts";
import type { NativeContext } from "./native.ts";

function ctx(): NativeContext {
  return {
    orgId: "org",
    refKey: "qboId",
    baseCurrency: "USD",
    control: { ar: "ar", ap: "ap", bank: "bank" },
    accountByRef: new Map(),
    accountRefById: new Map(),
    partyByRef: new Map(),
    deptByRef: new Map(),
    projectByRef: new Map(),
    itemByRef: new Map(),
    subsidiaryByRef: new Map(),
    segmentValueByRef: new Map(),
    rootSubsidiaryId: "root",
    taxByRate: new Map(),
    taxCodeByRef: new Map(),
    periodByRef: new Map(),
    periodFor: () => undefined,
  } as unknown as NativeContext;
}

const opts = {
  itemIncomeAccount: new Map<string, string>(),
  itemExpenseAccount: new Map<string, string>(),
};

function invoice(overrides: Partial<QboTxn> = {}): QboTxn {
  return {
    Id: "7",
    TxnDate: "2026-07-01",
    CurrencyRef: { value: "USD" },
    ExchangeRate: 1,
    TotalAmt: 100,
    Line: [
      {
        Amount: 100,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: "1" }, ItemAccountRef: { value: "2" } },
      },
    ],
    ...overrides,
  } as QboTxn;
}

test("only the exact provider void marker counts, never a mention", () => {
  assert.equal(qboVoidNote("Voided"), true);
  assert.equal(qboVoidNote("VOIDED"), true);
  assert.equal(qboVoidNote("  voided  "), true);
  assert.equal(qboVoidNote("avoided"), false);
  assert.equal(qboVoidNote("not voided"), false);
  assert.equal(qboVoidNote("previous invoice voided"), false);
  assert.equal(qboVoidNote("void"), false);
  assert.equal(qboVoidNote(""), false);
  assert.equal(qboVoidNote(null), false);
  assert.equal(qboVoidNote(undefined), false);
});

test("cancellation needs the exact marker and zeroed financials", () => {
  assert.equal(
    isQboVoided({ PrivateNote: "Voided", TotalAmt: 0, Line: [] }),
    true,
  );
  // Each observed zero shape suffices on its own (a voided payment carries
  // cleared lines with no TotalAmt; a voided invoice carries a zeroed total).
  assert.equal(isQboVoided({ PrivateNote: "Voided", TotalAmt: 0 }), true);
  assert.equal(isQboVoided({ PrivateNote: "Voided", Line: [] }), true);
  assert.equal(
    isQboVoided({ PrivateNote: "Voided", Line: [{ Amount: 0 }] }),
    true,
  );
  // Missing financials corroborate nothing — never infer zero.
  assert.equal(isQboVoided({ PrivateNote: "Voided" }), false);
  assert.equal(isQboVoided({ PrivateNote: "Voided", TotalAmt: null, Line: null }), false);
  // A populated line without an observed amount vetoes, alone or mixed.
  assert.equal(isQboVoided({ PrivateNote: "Voided", Line: [{}] }), false);
  assert.equal(isQboVoided({ PrivateNote: "Voided", Line: [{ Amount: null }] }), false);
  assert.equal(isQboVoided({ PrivateNote: "Voided", Line: [{ Amount: undefined }] }), false);
  assert.equal(
    isQboVoided({ PrivateNote: "Voided", Line: [{ Amount: 0 }, { Amount: undefined }] }),
    false,
  );
  assert.equal(
    isQboVoided({ PrivateNote: "Voided", TotalAmt: 0, Line: [{ Amount: undefined }] }),
    false,
  );
  // Exact marker on live money is a memo, not a void.
  assert.equal(
    isQboVoided({ PrivateNote: "Voided", TotalAmt: 100 }),
    false,
  );
  assert.equal(
    isQboVoided({ PrivateNote: "Voided", TotalAmt: 0, Line: [{ Amount: 50 }] }),
    false,
  );
  // Mention-void memos never cancel, even at zero.
  assert.equal(
    isQboVoided({ PrivateNote: "previous invoice voided", TotalAmt: 0, Line: [] }),
    false,
  );
  assert.equal(
    isQboVoided({ PrivateNote: "Customer avoided a late fee", TotalAmt: 100 }),
    false,
  );
});

test("a provider-voided transaction builds as cancelled", () => {
  const built = buildNativeFromQbo(
    ctx(),
    "Invoice",
    invoice({ PrivateNote: "Voided", TotalAmt: 0, Line: [] }),
    opts,
  );
  assert.deepEqual(built, { skip: "cancelled" });
});

test("mention-void memos build past cancellation into mapping", () => {
  // These must NOT return { skip: "cancelled" }. Mapping then fails on the
  // unmapped stub accounts, which proves the memo did not cancel the build.
  for (const note of [
    "Customer avoided a late fee, do not void",
    "not voided",
    "previous invoice voided",
  ]) {
    const built = buildNativeFromQbo(ctx(), "Invoice", invoice({ PrivateNote: note }), opts);
    assert.ok(!("skip" in built && built.skip === "cancelled"), note);
  }
  // Even the exact marker stays live while the money is nonzero.
  const live = buildNativeFromQbo(
    ctx(),
    "Invoice",
    invoice({ PrivateNote: "Voided" }),
    opts,
  );
  assert.ok(!("skip" in live && live.skip === "cancelled"));
});
