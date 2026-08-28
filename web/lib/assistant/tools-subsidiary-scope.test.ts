import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools.ts");
const data = read("../data.ts");
const statements = read("../reports/statements.ts");
const glSummary = read("../gl-summary.ts");
const cashFlow = read("../reports/cash-flow.ts");

test("restricted assistant callers carry their subsidiary allowlist into every financial report", () => {
  assert.match(tools, /function reportDims\(authz: Authz\)/);
  assert.match(tools, /return \{ subsidiaryIds: \[\.\.\.authz\.allowedSubsidiaryIds\] \}/);
  assert.match(tools, /profitAndLoss\([\s\S]*\.\.\.dims/);
  assert.match(tools, /balanceSheet\(a\.asOf, authz\.user\.orgId, undefined, reportDims\(authz\)\)/);
  assert.match(tools, /trialBalance\(a\.asOf, reportDims\(authz\), authz\.user\.orgId\)/);
  assert.match(tools, /agingByParty\(a\.side, asOf, reportDims\(authz\), authz\.user\.orgId\)/);
  assert.match(tools, /cashFlow\(range\.from, range\.to, reportDims\(authz\), authz\.user\.orgId\)/);
  assert.match(statements, /export async function balanceSheet\([\s\S]*dims\?: DimFilter/);
  assert.match(statements, /summaryAccountBalances\(resolvedOrgId, null, asOf, dims\?\.subsidiaryIds, bookId\)/);
});

test("unrestricted callers retain the explicit null-to-undefined sentinel", () => {
  assert.match(tools, /if \(authz\.allowedSubsidiaryIds === null\) return undefined/);
  assert.match(data, /subsidiaryVisibleFilter\([\s\S]*allowedSubsidiaryIds/);
  assert.match(statements, /summaryAccountBalances\(resolvedOrgId, from, to, dims\?\.subsidiaryIds, bookId\)/);
  assert.match(statements, /bucketSubsidiaryFilter\(dims\?\.subsidiaryIds\)/);
  assert.match(cashFlow, /bucketSubsidiaryFilter\(dims\?\.subsidiaryIds\)/);
});

test("empty restricted scopes fail closed for report helpers and journal reads", () => {
  assert.match(tools, /function reportScopeDenied\(authz: Authz\)/);
  assert.match(tools, /authz\.allowedSubsidiaryIds\?\.size === 0 \? \{ ok: false, error: "forbidden" \}/);
  assert.match(tools, /sql`e\.subsidiary_id`[\s\S]*authz\.allowedSubsidiaryIds/);
  assert.match(tools, /sql`l\.subsidiary_id`[\s\S]*authz\.allowedSubsidiaryIds/);
  assert.match(data, /sql`e\.subsidiary_id`[\s\S]*allowedSubsidiaryIds/);
  assert.match(data, /sql`l\.subsidiary_id`[\s\S]*allowedSubsidiaryIds/);
  assert.match(glSummary, /if \(subsidiaryIds === undefined\) return/);
  assert.match(glSummary, /: sql`and false`/);
});
