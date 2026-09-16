import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ranking = read("../project-ranking.ts");
const projects = read("./tools-projects.ts");
const tax = read("./tools-tax.ts");
const construction = read("./tools-construction.ts");
const registry = read("./registry.ts");

test("rank_projects scopes projects AND ledger lines to the caller's subsidiary allowlist", () => {
  assert.match(ranking, /subsidiaryVisibleFilter\(sql`p\.subsidiary_id`, allowedSubsidiaryIds\)/);
  assert.match(ranking, /subsidiaryVisibleFilter\(sql`l\.subsidiary_id`, allowedSubsidiaryIds\)/);
  assert.match(projects, /rankProjects\([\s\S]*authz\.allowedSubsidiaryIds,?\s*\)/);
  // Portfolio ranking classifies by account-id sets, never by joining accounts per line.
  assert.match(ranking, /l\.account_id in \(select id from cost_accounts\)/);
  assert.doesNotMatch(ranking, /join accounts a on a\.id = l\.account_id/);
});

test("tax_return narrows a restricted caller to one filing entity and fails closed on an empty scope", () => {
  assert.match(tax, /if \(allowed !== null && allowed\.size === 0\) return \{ ok: false, error: "forbidden" \}/);
  assert.match(tax, /filingEntity: \{ subsidiaryIds: \[\.\.\.allowed\] \}/);
  assert.match(tax, /subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  // Only the operator-facing engine error is surfaced; anything else stays private.
  assert.match(tax, /if \(error instanceof TaxReturnError\) return \{ ok: false, error: `tax_return: \$\{error\.message\}` \}/);
});

test("retainage_balances reads the configured control account under the caller's line scope", () => {
  assert.match(construction, /settings->'controlAccounts'->>\$\{roleKey\}/);
  assert.match(construction, /subsidiaryVisibleFilter\(sql`l\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/);
  assert.match(construction, /configured: false/);
});

test("the new tool groups are mounted on the shared assistant/MCP catalog", () => {
  for (const group of ["PROJECT_TOOLS", "TAX_TOOLS", "CONSTRUCTION_TOOLS"]) {
    assert.match(registry, new RegExp(`\\.\\.\\.${group},`));
  }
});
