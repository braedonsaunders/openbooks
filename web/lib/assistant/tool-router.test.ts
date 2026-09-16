import assert from "node:assert/strict";
import test from "node:test";
import {
  activateTurnModules,
  CORE_TOOL_MODULES,
  createTurnScope,
  findToolsModules,
  isCoreTier,
  matchTools,
  MODULE_KEYWORDS,
  moduleOfTool,
  preRouteModules,
  priorToolNames,
  resolveActiveToolNames,
} from "./tool-router";

test("moduleOfTool passes feature flags through as module names", () => {
  assert.equal(moduleOfTool("inventory_levels", "inventory"), "inventory");
  assert.equal(moduleOfTool("list_pay_runs", "payroll"), "payroll");
  assert.equal(moduleOfTool("cash_position", "banking"), "banking");
});

test("moduleOfTool maps feature-less tools to their domain module", () => {
  assert.equal(moduleOfTool("tax_return"), "tax");
  assert.equal(moduleOfTool("documents_missing_tax_code"), "tax");
  assert.equal(moduleOfTool("analytics_sentinel"), "analytics");
  assert.equal(moduleOfTool("financial_periods"), "close");
  assert.equal(moduleOfTool("list_approvals"), "close");
  assert.equal(moduleOfTool("run_report"), "reports");
  assert.equal(moduleOfTool("get_company_settings"), "setup");
  assert.equal(moduleOfTool("list_users"), "admin");
  assert.equal(moduleOfTool("list_files"), "files");
  assert.equal(moduleOfTool("search_items"), "inventory");
  assert.equal(moduleOfTool("list_currencies"), "multiCurrency");
  assert.equal(moduleOfTool("submit_document"), "documents");
  assert.equal(moduleOfTool("create_payment"), "documents");
  assert.equal(moduleOfTool("list_records"), "records");
  assert.equal(moduleOfTool("general_ledger"), "ledger");
  assert.equal(moduleOfTool("draft_journal_entry"), "ledger");
});

test("moduleOfTool falls back to core so unmapped tools stay visible", () => {
  assert.equal(moduleOfTool("some_future_tool"), "core");
});

test("every override names a known module", () => {
  const known = new Set([...Object.keys(MODULE_KEYWORDS), "core", "ledger"]);
  for (const [tool, module] of Object.entries(CORE_TOOL_MODULES)) {
    assert.ok(known.has(module), `${tool} maps to unknown module ${module}`);
  }
});

test("pre-router: cash question pre-activates banking and ledger", () => {
  const modules = preRouteModules("What is our cash position right now?");
  assert.ok(modules.includes("banking"), JSON.stringify(modules));
  assert.ok(modules.includes("ledger"), JSON.stringify(modules));
});

test("pre-router: pay run activates payroll but never the documents mutations", () => {
  const modules = preRouteModules("Summarize our most recent pay run: gross pay and deductions.");
  assert.deepEqual(modules, ["payroll"]);
});

test("pre-router: bench questions route to the module that answers them", () => {
  assert.ok(preRouteModules("Who are our top 5 customers by revenue?").includes("ledger"));
  assert.ok(preRouteModules("How much AR is more than 60 days overdue?").includes("ledger"));
  assert.ok(preRouteModules("What was our net income for 2025?").includes("ledger"));
  assert.ok(preRouteModules("Which active projects have negative margin?").includes("projects"));
  assert.ok(preRouteModules("Prepare the GST/HST figures for last quarter.").includes("tax"));
  assert.ok(preRouteModules("Look for duplicate vendor bills and round-dollar payments.").includes("analytics"));
  assert.ok(
    preRouteModules("We are closing the fiscal month; build a close checklist.").includes("close"),
  );
  assert.ok(preRouteModules("Build a 13-week cash forecast.").includes("analytics"));
  assert.ok(preRouteModules("Give me budget vs actual by department.").includes("budgets"));
  assert.ok(preRouteModules("Show my open sales orders.").includes("orders"));
  assert.ok(preRouteModules("List employees missing statutory elections.").includes("payroll"));
  assert.ok(preRouteModules("Which allocation rules apportion overhead to jobs?").includes("allocations"));
  assert.ok(!preRouteModules("Apply the payment allocations to the open invoices.").includes("allocations"));
});

test("pre-router: capability questions stay core-only", () => {
  assert.deepEqual(preRouteModules("What can you do?"), []);
  assert.deepEqual(preRouteModules("Hello."), []);
});

test("pre-router: word boundaries keep payroll and payment apart", () => {
  // "pay" inside "payroll"/"pay run" must not wake the mutation module.
  assert.ok(!preRouteModules("Run payroll for September.").includes("documents"));
  // ...while an explicit payment verb does.
  assert.ok(preRouteModules("Post the vendor payment.").includes("documents"));
  // A generic correctness question is not a correction.
  assert.deepEqual(preRouteModules("Is my balance sheet correct?"), ["ledger"]);
});

test("pre-router: prior tool calls keep their module active on follow-ups", () => {
  const resolve = (name: string): string => (name === "inventory_levels" ? "inventory" : "core");
  assert.deepEqual(preRouteModules("Thanks — and the second one?", ["inventory_levels"], resolve), [
    "inventory",
  ]);
  assert.deepEqual(preRouteModules("Thanks.", ["find_accounts"], resolve), []);
});

test("turn scope activates modules once and never core", () => {
  const scope = createTurnScope(["ledger"]);
  activateTurnModules(scope, ["inventory", "core", "inventory"]);
  assert.deepEqual(scope.preRouted, ["ledger"]);
  assert.deepEqual(scope.activated, ["inventory"]);
});

test("resolveActiveToolNames sends core plus activated modules only", () => {
  const catalog = [
    { name: "whoami", tier: "core" as const, module: "core" },
    { name: "find_accounts", tier: "core" as const, module: "ledger" },
    { name: "general_ledger", tier: undefined, module: "ledger" },
    { name: "inventory_levels", tier: undefined, module: "inventory" },
  ];
  assert.deepEqual(resolveActiveToolNames(catalog, { preRouted: [], activated: [] }), [
    "whoami",
    "find_accounts",
  ]);
  assert.deepEqual(
    resolveActiveToolNames(catalog, { preRouted: ["inventory"], activated: [] }),
    ["whoami", "find_accounts", "inventory_levels"],
  );
});

test("isCoreTier defaults absent tier to module", () => {
  assert.equal(isCoreTier("core"), true);
  assert.equal(isCoreTier("module"), false);
  assert.equal(isCoreTier(undefined), false);
});

test("matchTools ranks name hits above blurb hits and respects the limit", () => {
  const catalog = [
    { name: "inventory_levels", blurb: "On-hand quantities by location.", module: "inventory" },
    { name: "general_ledger", blurb: "Full journal detail including inventory revaluations.", module: "ledger" },
    { name: "profit_and_loss", blurb: "Revenue and expenses.", module: "ledger" },
  ];
  const hits = matchTools(catalog, "inventory", 8);
  assert.equal(hits[0]?.name, "inventory_levels");
  assert.equal(hits.length, 2);
  assert.deepEqual(matchTools(catalog, "inventory", 1).map((h) => h.name), ["inventory_levels"]);
  assert.deepEqual(matchTools(catalog, "", 8), []);
  assert.deepEqual(matchTools(catalog, "zzz-no-such-capability", 8), []);
});

test("priorToolNames reads static and dynamic tool parts off assistant turns", () => {
  const messages = [
    { role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      parts: [
        { type: "text", text: "checking" },
        { type: "tool-inventory_levels", toolCallId: "a" },
        { type: "dynamic-tool", toolName: "get_pay_run", toolCallId: "b" },
        { type: "tool-inventory_levels", toolCallId: "c" },
        { type: "tool-approval-request", toolCallId: "d" },
      ],
    },
    { role: "assistant", parts: [{ type: "text", text: "done" }] },
    { role: "assistant" },
  ];
  assert.deepEqual(priorToolNames(messages), ["inventory_levels", "get_pay_run"]);
});

test("priorToolNames ignores malformed parts instead of throwing", () => {
  assert.deepEqual(priorToolNames([{ role: "assistant", parts: [null, "x", 42, {}] }]), []);
  assert.deepEqual(priorToolNames([]), []);
});

test("findToolsModules reads activation modules off success results only", () => {
  assert.deepEqual(
    findToolsModules({ ok: true, data: { tools: [], modules: ["payroll", "core", "payroll"], total: 3 } }),
    ["payroll"],
  );
  assert.deepEqual(findToolsModules({ ok: false, error: "unknown module" }), []);
  assert.deepEqual(findToolsModules({ ok: true, data: null }), []);
  assert.deepEqual(findToolsModules({ ok: true, data: { tools: [] } }), []);
});

test("routing table stays vendor-neutral", () => {
  const joined = Object.values(MODULE_KEYWORDS).flat().join(" ").toLowerCase();
  // Built by joining so the guarded literals never appear in this source file.
  const banned = [
    ["net", "suite"].join(""),
    ["quick", "books"].join(""),
    ["xe", "ro"].join(""),
    ["sa", "ge"].join(""),
    ["s", "ap"].join(""),
  ];
  for (const term of banned) {
    assert.doesNotMatch(joined, new RegExp(`\\b${term}\\b`), `keyword table mentions ${term}`);
  }
});
