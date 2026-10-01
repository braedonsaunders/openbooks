import assert from "node:assert/strict";
import test from "node:test";
import { PROGRAM_STATUS_TRANSITIONS } from "./program-types.ts";

test("program status moves close the loop: drafts activate, active close", () => {
  assert.deepEqual([...PROGRAM_STATUS_TRANSITIONS.draft], ["active"]);
  assert.deepEqual([...PROGRAM_STATUS_TRANSITIONS.active], ["closed"]);
  assert.deepEqual([...PROGRAM_STATUS_TRANSITIONS.closed], []);
});
