import assert from "node:assert/strict";
import test from "node:test";
import { reserveVendorRetainageSources } from "./vendor-retainage-sources.ts";

test("retainage reservations keep original source identities across partial draws", () => {
  const sources = [{ documentId: "first", held: "100" }, { documentId: "second", held: "50" }];
  assert.deepEqual(reserveVendorRetainageSources(sources, "70", "50"), [
    { documentId: "first", held: "100.0000", previousAmount: "70.0000", amount: "30.0000" },
    { documentId: "second", held: "50.0000", previousAmount: "0.0000", amount: "20.0000" },
  ]);
  assert.deepEqual(reserveVendorRetainageSources(sources, "120", "30"), [
    { documentId: "second", held: "50.0000", previousAmount: "20.0000", amount: "30.0000" },
  ]);
  assert.throws(() => reserveVendorRetainageSources(sources, "120", "31"), /cannot be matched/);
  assert.throws(() => reserveVendorRetainageSources(sources, "1e2", "1"), /exact nonnegative/);
});
