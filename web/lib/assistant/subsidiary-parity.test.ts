import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * Subsidiary-scoping contract: every tool that lists tenant rows applies
 * `subsidiaryVisibleFilter` (or the shared service it reuses does), empty
 * restricted scopes fail closed, and tables without a subsidiary column are
 * the only exemption — pinned against the baseline schema so a future
 * column addition reopens the question instead of silently widening.
 */

function toolBlocks(source: string): { name: string; body: string }[] {
  const starts: { name: string; index: number }[] = [];
  for (const match of source.matchAll(/name: "([a-z0-9_]+)",\n/g)) {
    if (match.index !== undefined) starts.push({ name: match[1]!, index: match.index });
  }
  return starts.map((start, i) => ({
    name: start.name,
    body: source.slice(start.index, i + 1 < starts.length ? starts[i + 1]!.index : undefined),
  }));
}

function blockOf(file: string, tool: string): string {
  const found = toolBlocks(read(file)).find((b) => b.name === tool);
  assert.ok(found, `${file} has no tool block named ${tool}`);
  return found.body;
}

/** [tool, file, expected subsidiaryVisibleFilter column expression] */
const DIRECT_ROWS: [string, string, string][] = [
  ["find_journal_entries", "./tools.ts", "sql`e.subsidiary_id`"],
  ["find_documents", "./tools.ts", "sql`d.subsidiary_id`"],
  ["get_document", "./tools.ts", "sql`d.subsidiary_id`"],
  ["find_parties", "./tools.ts", "sql`subsidiary_id`"],
  ["party_concentration", "./tools.ts", "sql`d.subsidiary_id`"],
  ["project_profitability", "./tools.ts", "sql`p.subsidiary_id`"],
  ["financial_periods", "./tools.ts", "sql`l.subsidiary_id`"],
  ["list_bank_reconciliations", "./tools-banking.ts", "sql`a.subsidiary_id`"],
  ["get_bank_reconciliation", "./tools-banking.ts", "sql`a.subsidiary_id`"],
  ["list_unmatched_bank_lines", "./tools-banking.ts", "sql`a.subsidiary_id`"],
  ["retainage_balances", "./tools-construction.ts", "sql`l.subsidiary_id`"],
  ["documents_missing_tax_code", "./tools-tax.ts", "sql`d.subsidiary_id`"],
  ["list_pay_runs", "./tools-payroll.ts", "sql`d.subsidiary_id`"],
];

test("tenant-row listings filter to the caller's subsidiary allowlist", () => {
  const flat = (s: string) => s.replace(/\s+/g, "");
  for (const [tool, file, column] of DIRECT_ROWS) {
    const body = flat(blockOf(file, tool));
    assert.ok(
      body.includes(flat(`subsidiaryVisibleFilter(${column},authz.allowedSubsidiaryIds`)),
      `${tool}: must scope ${column} to authz.allowedSubsidiaryIds`,
    );
  }
});

test("single-entry and register reads hand the allowlist to their shared services", () => {
  const tools = read("./tools.ts");
  assert.ok(
    tools.includes("entryDetail(authz.user.orgId, a.entryId, authz.allowedSubsidiaryIds,"),
    "get_journal_entry must scope through entryDetail",
  );
  assert.ok(
    tools.includes("accountRegister(authz.user.orgId, a.accountId, limit, 0, undefined, authz.allowedSubsidiaryIds,"),
    "account_register must scope through accountRegister",
  );
  assert.ok(
    tools.includes("accountsWithBalances(authz.user.orgId, a.asOf, authz.allowedSubsidiaryIds)"),
    "find_accounts must scope through accountsWithBalances",
  );
});

test("restricted financial-period callers never see other entities' close runs", () => {
  const body = blockOf("./tools.ts", "financial_periods");
  assert.ok(
    body.includes("authz.allowedSubsidiaryIds === null ? sql`` : sql`and false`"),
    "close_runs join must go blind for restricted callers, not leak run status",
  );
});

/** Tools whose scope travels through the shared report helpers. */
const REPORT_SCOPED = [
  "profit_and_loss", "balance_sheet", "trial_balance", "aging", "cash_flow",
  "financial_trends", "budget_vs_actual", "list_open_items",
];

test("statement and aggregate tools carry the allowlist through reportDims and fail closed when empty", () => {
  const tools = read("./tools.ts");
  assert.ok(tools.includes("function reportDims(authz: Authz)"));
  assert.ok(tools.includes('authz.allowedSubsidiaryIds?.size === 0 ? { ok: false, error: "forbidden" }'));
  for (const tool of REPORT_SCOPED) {
    const body = blockOf("./tools.ts", tool);
    assert.ok(
      body.includes("reportDims(authz)") || body.includes("reportScopeDenied(authz)"),
      `${tool}: must use reportDims and/or reportScopeDenied`,
    );
  }
});

test("reporting tools scope through the same helpers", () => {
  const reports = read("./tools-reports.ts");
  assert.ok(reports.includes("function reportDims(authz: Authz)"));
  for (const tool of ["general_ledger", "aging_detail", "cash_flow_indirect", "partner_statement"]) {
    const body = blockOf("./tools-reports.ts", tool);
    assert.ok(body.includes("reportScopeDenied(authz)"), `${tool}: must fail closed on an empty scope`);
    assert.ok(body.includes("reportDims(authz)"), `${tool}: must carry reportDims`);
  }
});

test("analytics dashboards and cockpits hand the allowlist to their services", () => {
  const analytics = read("./tools-analytics.ts");
  for (const tool of [
    "analytics_financial_health", "analytics_customer_intelligence", "analytics_vendor_performance",
    "analytics_cashflow", "analytics_true_cost", "analytics_utilization", "analytics_spend_velocity",
    "ap_position", "ar_position", "cash_position",
  ]) {
    const body = toolBlocks(analytics).find((b) => b.name === tool)!.body;
    assert.ok(body.includes("authz.allowedSubsidiaryIds"), `${tool}: must pass the allowlist down`);
  }
});

test("tax_return narrows restricted callers to one filing entity and fails closed when empty", () => {
  const body = blockOf("./tools-tax.ts", "tax_return");
  assert.ok(body.includes("if (allowed !== null && allowed.size === 0)"));
  assert.ok(body.includes("filingEntity: { subsidiaryIds: [...allowed] }"));
});

test("payroll tools scope through the shared payroll helpers", () => {
  const payroll = read("./tools-payroll.ts");
  assert.ok(payroll.includes("payrollVisiblePartyFilter(authz)"), "employee listing must filter visible parties");
  assert.ok(
    payroll.includes("payrollRunPopulationScopeFilter(authz.user.orgId, sql`r.document_id`, authz.allowedSubsidiaryIds)"),
    "pay-run reads must scope the run population",
  );
  assert.ok(payroll.includes("subsidiaryScopeAllows(authz.allowedSubsidiaryIds"), "single-run reads must check scope");
  assert.ok(payroll.includes("scopedYearEndFilings(authz"), "year-end filings must run scoped");
  assert.ok(payroll.includes("scopedRemittanceSummary(authz"), "remittances must run scoped");
  assert.ok(
    read("../payroll-scoped-views.ts").includes("gate.allowedSubsidiaryIds"),
    "scoped payroll views must consume the allowlist",
  );
});

test("file tools enforce per-folder grants under the caller's identity and scope", () => {
  const files = read("./tools-files.ts");
  assert.ok(files.includes("allowedSubsidiaryIds: authz.allowedSubsidiaryIds"), "folder checks must see the scope");
  assert.ok(files.includes("isAdmin: can(authz"), "folder checks must see admin bypass, not assume it");
});

test("setup record listing stays org-scoped through the shared registry command", () => {
  const body = blockOf("./tools-setup.ts", "list_setup_records");
  assert.ok(body.includes("and org_id = ${orgId}"), "org scoping is mandatory on every setup query");
  assert.ok(body.includes("setupEntityEnabled(base, features)"), "per-entity feature fence stays");
});

/** Tables without a subsidiary_id column: org scoping is the whole story. */
const ORG_ONLY_TABLES = [
  "ai_work_items",
  "bank_feed_connections",
  "close_reporting_packages",
  "budget_scenarios",
  "report_definitions",
  "report_schedules",
  "tax_return_forms",
  "tax_registrations",
];

function createTableBlock(schema: string, table: string): string {
  const at = schema.indexOf(`CREATE TABLE public.${table} (`);
  assert.ok(at >= 0, `baseline schema has no ${table}`);
  return schema.slice(at, schema.indexOf(";", at));
}

test("org-only tables carry no subsidiary column (exemption pinned to the schema)", () => {
  const schema = read("../../../schema/migrations/generated/0001_baseline.sql");
  for (const table of ORG_ONLY_TABLES) {
    assert.doesNotMatch(createTableBlock(schema, table), /subsidiary_id/);
  }
});

test("draft_journal_entry proposes without postings; scope is enforced at commit", () => {
  const body = blockOf("./tools-write.ts", "draft_journal_entry");
  assert.ok(body.includes("requiresConfirmation: true"), "drafts must require confirmation");
  assert.ok(body.includes("signProposal("), "proposal must be signed for the commit route");
  assert.ok(body.includes("nothing is created until they click Apply"), "model must never claim a write");
});
