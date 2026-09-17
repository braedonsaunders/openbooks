import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// F-t06-026: the close task swallowed the consolidation 422 because the
// route answered bare {error} text. The route must answer the typed
// {error, code} pair the engine refusal carries so the task can persist
// and localize it.
const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("consolidation refusals answer the typed error/code pair (F-t06-026)", () => {
  assert.match(
    source,
    /\{\s*error: e\.message,\s*code: e\.code\s*\}/,
    "the ConsolidationError branch must return both the message and its code",
  );
});
