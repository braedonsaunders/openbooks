import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContinuousCloseDetectors } from "../agents/continuous-close-config.ts";

test("project detector parameter validation still refuses a zero unbilled window", () => {
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("projects", {
        project_stale_unbilled: { parameters: { unbilledDays: 0 } }
      }),
    /invalid detector parameter/,
  );
});

