import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seedSource = readFileSync(new URL("./seed-rate-adjustments.ts", import.meta.url), "utf8");

test("labor rate-adjustment upserts pin the known tenant on the version_id/code conflict write", () => {
  assert.match(
    seedSource,
    /insert into labor_rate_adjustments[\s\S]*?on conflict \(version_id, code\) do update set[\s\S]*?where labor_rate_adjustments\.org_id = \$\{ORG\}/,
  );
});
