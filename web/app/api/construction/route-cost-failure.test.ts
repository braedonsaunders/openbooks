import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The construction overview renders committed cost beside real contract
// figures. A failed cost summary used to collapse into committedCost
// "0.0000" — indistinguishable from a project with no commitments. The
// failure must fail the request instead, never a fake zero.

const dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(dir, "route.ts"), "utf8");

test("a failed cost summary fails the request instead of rendering zero", () => {
  assert.ok(
    !/projectCostSummary\([^)]*\)\.catch\(\(\) => null\)/.test(src),
    "a .catch(() => null) on the cost summary renders failures as 0.0000",
  );
  assert.ok(
    !/committed\?\.committed\?\.cost \?\? "0\.0000"/.test(src),
    "no zero fallback may stand in for a failed cost summary",
  );
});
