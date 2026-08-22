import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./project-revenue.ts", import.meta.url), "utf8");

test("project POC recognition-rule upserts pin the known tenant on the org_id/code conflict write", () => {
  assert.match(
    source,
    /insert into recognition_rules[\s\S]*?on conflict \(org_id, code\) do update set[\s\S]*?where recognition_rules\.org_id = \$\{orgId\}/,
  );
});
