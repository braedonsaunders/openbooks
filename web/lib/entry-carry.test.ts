import assert from "node:assert/strict";
import test from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
  window: {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  },
});
const { stashEntryCarry, takeEntryCarry } = await import("./entry-carry");

test("Save & new carries the date and party once, for the same kind only", () => {
  stashEntryCarry("vendor_bill", { documentDate: "2026-10-15", partyId: "p1" });
  assert.equal(takeEntryCarry("customer_invoice"), null);
  assert.deepEqual(takeEntryCarry("vendor_bill"), { documentDate: "2026-10-15", partyId: "p1" });
  assert.equal(takeEntryCarry("vendor_bill"), null);
});

test("a stale or malformed carry is ignored", () => {
  store.set(
    "openbooks:entry-carry:vendor_bill",
    JSON.stringify({ documentDate: "2026-10-15", partyId: "p1", at: Date.now() - 60_000 }),
  );
  assert.equal(takeEntryCarry("vendor_bill"), null);
  store.set(
    "openbooks:entry-carry:vendor_bill",
    JSON.stringify({ documentDate: "10/15/2026", partyId: 3, at: Date.now() }),
  );
  assert.deepEqual(takeEntryCarry("vendor_bill"), { documentDate: null, partyId: null });
});

test("carrying nothing clears any previous carry", () => {
  stashEntryCarry("vendor_bill", { documentDate: "2026-10-15", partyId: null });
  stashEntryCarry("vendor_bill", { documentDate: null, partyId: null });
  assert.equal(takeEntryCarry("vendor_bill"), null);
});
