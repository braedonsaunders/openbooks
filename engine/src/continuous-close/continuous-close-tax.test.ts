import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContinuousCloseDetectors } from "../agents/continuous-close-config.ts";

test("tax detector parameter validation still refuses an overlong lookback", () => {
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("tax", {
        tax_missing_codes: { parameters: { lookbackDays: 366 } }
      }),
    /invalid detector parameter/,
  );
});

