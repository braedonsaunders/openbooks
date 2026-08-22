import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./dashboard-defaults.ts", import.meta.url), "utf8");

test("role dashboard default upserts pin the known tenant on the org_id/role_key conflict write", () => {
  assert.match(
    source,
    /insert into role_dashboard_layouts[\s\S]*?on conflict \(org_id, role_key\) do update[\s\S]*?where role_dashboard_layouts\.org_id = \$\{orgId\}/,
  );
});
