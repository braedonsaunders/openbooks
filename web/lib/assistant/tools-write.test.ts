import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./tools-write.ts", import.meta.url), "utf8");

test("assistant journal proposals preserve valid four-decimal amounts", () => {
  // A four-decimal input such as 1.2345 is normalized by the canonical money
  // helper and must reach the signed preview unchanged; the old cents formatter
  // silently changed it to 1.23 before the user could confirm it.
  assert.match(source, /amount: exactAmounts\[index\]!,/);
  assert.doesNotMatch(source, /amount:\s*formatMoney\(exactAmounts\[index\]!,\s*2\)/);
});

test("assistant journal proposals still normalize amounts through canonical helpers", () => {
  assert.match(source, /canonicalDecimal\(line\.amount, 4\)/);
  assert.match(source, /return normalizeMoney\(exact\)/);
});
