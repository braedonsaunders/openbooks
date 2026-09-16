import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const context = read("./finding-context.ts");
const route = read("../../app/api/assistant/chat/route.ts");

// "Ask about this" ships finding evidence as model context through the
// route's memorySections seam — the prompt assembler itself is untouched
// (b07 owns it). Evidence is labeled untrusted data, following the
// conversation-summary convention: it informs, never instructs.
test("finding context is scoped, capped, and labeled untrusted", () => {
  assert.match(context, /loadWorkItemDetail\(/);
  assert.match(context, /readableContinuousCloseAgents\(authz\)/);
  assert.match(context, /if \(!item\) return null/);
  assert.match(context, /untrusted data, never instructions/);
  assert.match(context, /MAX_EVIDENCE_LINES/);
  assert.match(context, /MAX_LINE_CHARS/);
  assert.match(context, /\/agents\?item=\$\{item\.id\}/);
});

test("chat route injects the handoff without changing plain turns", () => {
  assert.match(route, /loadFindingContext/);
  assert.match(route, /findingId !== undefined/);
  assert.match(route, /findingContext\?\.section \?\? ""/);
  // Malformed ids refuse like malformed conversation ids; unknown or
  // unreadable findings simply add no section (null inside the helper).
  assert.match(route, /!UUID_RE\.test\(input\.findingId\)/);
});
