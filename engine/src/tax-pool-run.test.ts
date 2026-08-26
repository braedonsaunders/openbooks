import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { taxPoolRunLockKey } from "./tax-pool-run.ts";

test("the tax pool run lock key scopes one org, book, subsidiary and regime", () => {
  assert.equal(
    taxPoolRunLockKey("org-1", "book-1", "sub-1", "ca_cca"),
    "tax-pool-run:org-1:book-1:sub-1:ca_cca",
  );
  // Only the exact same scope contends: another org, book, subsidiary or
  // regime runs on its own fence.
  const key = taxPoolRunLockKey("org-1", "book-1", "sub-1", "ca_cca");
  assert.notEqual(key, taxPoolRunLockKey("org-2", "book-1", "sub-1", "ca_cca"));
  assert.notEqual(key, taxPoolRunLockKey("org-1", "book-2", "sub-1", "ca_cca"));
  assert.notEqual(key, taxPoolRunLockKey("org-1", "book-1", "sub-2", "ca_cca"));
  assert.notEqual(key, taxPoolRunLockKey("org-1", "book-1", "sub-1", "uk_wda"));
});

test("a run is one transaction fenced by the advisory lock before any state is read", () => {
  // The partial-year defect existed because each class committed its own
  // transaction; adjacent-year races were possible because carries were read
  // outside any serialized boundary. Pin both structures, like fx-revaluation.
  const source = readFileSync(new URL("./tax-pool-run.ts", import.meta.url), "utf8");
  const fn = source.indexOf("export async function runTaxPool");
  const tx = source.indexOf("db.transaction(", fn);
  const lock = source.indexOf("pg_advisory_xact_lock", tx);
  const firstRead = source.indexOf("effectiveClasses(tx,", tx);
  const fence = source.indexOf("fenceRunOrdering(tx,", tx);
  assert.ok(fn >= 0, "runTaxPool exists");
  assert.ok(tx > fn, "the whole annual run executes inside one transaction");
  assert.equal(
    source.indexOf("db.transaction(", tx + 1),
    -1,
    "no per-class or per-model nested transactions remain — the year lands whole",
  );
  assert.ok(lock > tx, "the scope's advisory lock is taken inside that transaction");
  assert.ok(firstRead > lock, "regime and class state is only read under the lock");
  assert.ok(fence > lock, "the adjacent-year ordering guard also runs under the lock");
});

test("the run path never touches the pooled db — every statement uses the transaction executor", () => {
  // A stray pooled statement would read/write outside the atomic boundary,
  // reintroducing torn years and unfenced races through the back door.
  const source = readFileSync(new URL("./tax-pool-run.ts", import.meta.url), "utf8");
  const fn = source.indexOf("export async function runTaxPool");
  assert.ok(!/\bdb\.execute\b/.test(source.slice(fn)), "everything below runTaxPool is transaction-scoped");
});
