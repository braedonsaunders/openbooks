import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// A rescind writes its pre-rescind employment snapshot into the event's
// audit evidence. When that read failed, the evidence silently recorded a
// null prior state — permanently filing incomplete audit history for a
// history-rewriting event. The rescind must refuse instead, naming the
// missing evidence and its remedy.

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "event-verbs.ts"), "utf8");

test("an unreadable pre-rescind snapshot refuses the rescind", () => {
  assert.ok(
    !/getEmploymentAsOf\(\{[\s\S]*?\}\)\.catch\(\(\) => null\)/.test(src),
    "a .catch(() => null) on the pre-rescind snapshot files null audit evidence",
  );
  assert.match(
    src,
    /pre-rescind employment snapshot could not be read/,
    "the refusal must name the missing evidence",
  );
  assert.match(
    src,
    /throw new EventVerbError\(\s*"the pre-rescind employment snapshot could not be read/,
    "the unreadable snapshot must refuse through EventVerbError, not a silent null",
  );
  assert.match(
    src,
    /priorSnapshot: \{ rescinded: target\.id, state: preSnapshot \}/,
    "the written evidence carries the live snapshot",
  );
});
