import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const payrollUnionSource = readFileSync(new URL("./payroll-union.ts", import.meta.url), "utf8");

test("union fringe upserts pin the known tenant on the agreement_id/code conflict write", () => {
  assert.match(
    payrollUnionSource,
    /insert into union_fringes[\s\S]*?on conflict \(agreement_id, code\) do update[\s\S]*?where union_fringes\.org_id = \$\{orgId\}/,
  );
});

test("union fringe component upserts pin the known tenant on the org_id/code conflict write", () => {
  assert.match(
    payrollUnionSource,
    /insert into pay_components[\s\S]*?on conflict \(org_id, code\) do update[\s\S]*?where pay_components\.org_id = \$\{orgId\}/,
  );
});
