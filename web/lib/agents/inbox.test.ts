import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const inbox = read("./inbox.ts");

// The inbox is the workbench's single resolver: tenant scoping, the
// assistant.use doorway, and per-pack narrowing must live here — not in each
// screen — so the inbox, tile, and briefing can never disagree.
test("inbox enforces doorway, tenancy, and pack narrowing", () => {
  assert.match(inbox, /if \(!can\(authz, "assistant\.use"\)\) return empty/);
  assert.match(inbox, /w\.org_id = \$\{authz\.user\.orgId\}/);
  assert.match(inbox, /readableContinuousCloseAgents\(authz\)/);
  assert.match(inbox, /filters\.packs \?\? \[\]\)\.filter\(\(p\) => readable\.includes\(p\)\)/);
  assert.match(inbox, /if \(agents\.length === 0\) return/);
});

// Ranking is exact and documented: materiality × confidence × age amplification,
// computed in SQL over ALL matches — never a client-side re-sort of a page.
test("inbox ranks by materiality times confidence times age in SQL", () => {
  assert.match(inbox, /w\.materiality \* w\.confidence/);
  assert.match(inbox, /now\(\) - w\.first_detected_at/);
  assert.match(inbox, /order by score desc/);
});

// Money stays canonical decimal strings; the float score is rank-only.
test("inbox keeps money canonical and flags truncation", () => {
  assert.match(inbox, /confidence::text as confidence, w\.materiality::text as materiality/);
  assert.match(inbox, /::float8 as score/);
  assert.match(inbox, /truncated: rows\.rows\.length > limit/);
});

// Proposals ride the persisted summary carrier (no second store); the since
// filter powers "what changed since I last looked".
test("inbox reads the proposal carrier and the since filter", () => {
  assert.match(inbox, /w\.summary \? 'proposedCommand'/);
  assert.match(inbox, /w\.last_detected_at > /);
});
