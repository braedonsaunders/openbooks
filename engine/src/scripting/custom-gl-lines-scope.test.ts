import assert from "node:assert/strict";
import test from "node:test";
import { customGlLineOutOfScopeIndex } from "./scripting.ts";

const SUB_A = "10000000-0000-4000-8000-000000000001";
const SUB_B = "10000000-0000-4000-8000-000000000002";

test("a line without a subsidiary inherits the document subsidiary for scope checks", () => {
  assert.equal(customGlLineOutOfScopeIndex([{ subsidiaryId: null }], SUB_B, new Set([SUB_A])), 1);
});

test("explicit allowed subsidiaries and unrestricted owners remain permitted", () => {
  assert.equal(
    customGlLineOutOfScopeIndex([{ subsidiaryId: SUB_A }], SUB_B, new Set([SUB_A])),
    null,
  );
  assert.equal(customGlLineOutOfScopeIndex([{ subsidiaryId: null }], SUB_B, null), null);
});
