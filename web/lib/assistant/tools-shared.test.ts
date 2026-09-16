import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// tools-shared.ts is server-only; run its pure helpers under Node with the
// same marker shim the other assistant tests use.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier.startsWith("@/")) {
      const path = root + "web/" + specifier.slice(2);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
      }
      return nextResolve(path, context);
    }
    return nextResolve(specifier, context);
  },
});

const { compactRows, capList, num, MAX_LIST_ROWS, MAX_ROW_STRING } = await import("./tools-shared.ts");

test("num rounds to cents and normalizes negative zero", () => {
  assert.equal(num("12.345"), 12.35);
  assert.equal(num("abc"), 0);
  assert.ok(Object.is(num(-0.0001), 0));
  assert.ok(Object.is(num("-0"), 0));
});

test("compactRows caps the list and reports total/returned/truncated", () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(compactRows(rows, { limit: 3 }), {
    items: [1, 2, 3],
    total: 5,
    returned: 3,
    truncated: true,
  });
  assert.deepEqual(compactRows(rows, { limit: 5 }), {
    items: [1, 2, 3, 4, 5],
    total: 5,
    returned: 5,
    truncated: false,
  });
  assert.deepEqual(compactRows([], { limit: 3 }), { items: [], total: 0, returned: 0, truncated: false });
});

test("compactRows defaults to the catalog list budget", () => {
  assert.equal(MAX_LIST_ROWS, 200);
  const rows = Array.from({ length: MAX_LIST_ROWS + 1 }, (_, i) => i);
  const result = compactRows(rows);
  assert.equal(result.returned, MAX_LIST_ROWS);
  assert.equal(result.total, MAX_LIST_ROWS + 1);
  assert.equal(result.truncated, true);
});

test("compactRows trims wide strings with a marker and leaves the rest alone", () => {
  assert.equal(MAX_ROW_STRING, 500);
  const wide = "x".repeat(MAX_ROW_STRING + 10);
  const result = compactRows(
    [{ memo: wide, short: "ok", nested: { note: wide, list: [wide, 7] }, when: null, n: 3, flag: true }],
    { maxString: MAX_ROW_STRING },
  );
  const row = result.items[0] as { memo: string; short: string; nested: { note: string; list: unknown[] }; when: null; n: number; flag: boolean };
  assert.equal(row.memo, `${"x".repeat(MAX_ROW_STRING)}…[truncated]`);
  assert.equal(row.short, "ok");
  assert.equal(row.nested.note, row.memo);
  assert.equal(row.nested.list[0], row.memo);
  assert.equal(row.nested.list[1], 7);
  assert.equal(row.when, null);
  assert.equal(row.n, 3);
  assert.equal(row.flag, true);
});

test("compactRows keeps short strings byte-identical (no marker noise)", () => {
  const exact = "y".repeat(MAX_ROW_STRING);
  const result = compactRows([{ memo: exact }]);
  assert.equal((result.items[0] as { memo: string }).memo, exact);
});

test("compactRows never mutates class instances", () => {
  const when = new Date("2026-01-15T00:00:00.000Z");
  const result = compactRows([{ when }]);
  assert.ok((result.items[0] as { when: unknown }).when instanceof Date);
});

test("capList keeps its existing contract", () => {
  assert.deepEqual(capList([1, 2, 3], 2), { items: [1, 2], truncated: true });
  assert.deepEqual(capList([1], 2), { items: [1], truncated: false });
});
