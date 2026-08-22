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

test("prior-amount upserts pin the known tenant on the prior_stub_id/kind/slot conflict write", () => {
  assert.match(
    storeSource,
    /insert into payroll_prior_amounts[\s\S]*?on conflict \(prior_stub_id, kind, slot\) do update set[\s\S]*?where payroll_prior_amounts\.org_id = \$\{input\.orgId\}/,
  );
});
