import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./sample-companies/service.ts", import.meta.url), "utf8");

test("sample-company access upserts pin the known tenant on the member_user_id/org_id conflict write", () => {
  assert.match(
    source,
    /insert into user_org_access[\s\S]*?on conflict \(member_user_id, org_id\) do update[\s\S]*?where user_org_access\.org_id = \$\{args\.sandboxOrgId\}/,
  );
});
