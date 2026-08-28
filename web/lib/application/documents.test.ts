import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./documents.ts", import.meta.url), "utf8");

test("posted correction routes approval flows inside the idempotent command", () => {
  const commandStart = SOURCE.indexOf("export async function correctPostedDocument");
  assert.ok(commandStart >= 0, "correctPostedDocument must exist");
  const command = SOURCE.slice(commandStart);
  const callbackStart = command.indexOf("execute: async () => {");
  assert.ok(callbackStart >= 0, "correction must use an idempotent execute callback");
  const callbackEnd = command.indexOf("\n      }\n    },", callbackStart);
  assert.ok(callbackEnd > callbackStart, "idempotent execute callback must be closed");

  const dispatch = command.indexOf("runPostedCorrectionDraftFlows(", callbackStart);
  assert.ok(
    dispatch > callbackStart && dispatch < callbackEnd,
    "approval routing must run before the idempotent callback commits",
  );
  assert.equal(
    command.indexOf("if (!outcome.replayed)", callbackEnd),
    -1,
    "completed idempotency replays must not bypass correction routing",
  );
});
