import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storeSource = readFileSync(new URL("./payroll-parallel-run-store.ts", import.meta.url), "utf8");

test("prior-stub upserts pin the known tenant on the register_id/employee_party_id conflict write", () => {
  assert.match(
    storeSource,
    /insert into payroll_prior_stubs[\s\S]*?on conflict \(register_id, employee_party_id\) do update set[\s\S]*?where payroll_prior_stubs\.org_id = \$\{input\.orgId\}/,
  );
});
