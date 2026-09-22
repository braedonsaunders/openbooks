import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./payroll-read.ts", import.meta.url), "utf8");

test("payroll employee list scopes parties and never selects sealed identity columns", () => {
  const select = SOURCE.slice(SOURCE.indexOf("select prof.id"), SOURCE.indexOf("from employee_payroll_profiles"));
  assert.match(SOURCE, /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`/);
  assert.doesNotMatch(SOURCE, /from ["'].*app\/api\/payroll/);
  assert.doesNotMatch(select, /government_id|ssn|sin|tin|extra_withholding|election/i);
  assert.match(SOURCE, /GET \/api\/v1\/settings\/features/);
});
