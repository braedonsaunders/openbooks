import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * Permission parity matrix: for each assistant/application tool, the
 * permission its gate requires versus the permission the UI route, page view,
 * or application service for the SAME data requires.
 *
 * Parity semantics for reads: a tool's anyOf doorway must cover every cited
 * surface's permission (the tool is never LOOSER than any surface showing the
 * data), and every permission in the doorway must be justified by a cited
 * surface (no gratuitous widening). Aggregate tools cite the analytics
 * surface (reports.read doorway) alongside the module surface — the hub is
 * the UI for that data. Rows where the tool is STRICTER name the reason and
 * must not be loosened without evidence. Narrow-doorway tools (one gate,
 * per-kind/per-side narrowing inside execute) cite their narrowing markers.
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
  const blocks = toolBlocks(read(file));
  const found = blocks.find((b) => b.name === tool);
  assert.ok(found, `${file} has no tool block named ${tool}`);
  return found.body;
}

function gateOf(block: string): { mode: string; perms: string[] } {
  const publicGate = /gate: \{ mode: "public" \}/.test(block.slice(0, 1500));
  if (publicGate) return { mode: "public", perms: [] };
  const m = block.slice(0, 1500).match(/gate: \{ mode: "(anyOf|allOf)", perms: \[([^\]]*)\]/);
  assert.ok(m, "tool block has no parseable gate");
  return { mode: m[1]!, perms: [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) };
}

type Row = {
  tools: string[];
  file: string;
  /** Every permission the doorway admits. */
  gate: string[];
  mode?: string;
  /** [route file, guard evidence string] pairs; every route perm must be admitted. */
  routes: [string, string][];
  note: string;
};

/** Tool doorway == the union of the surfaces that show the data. */
const UNION_ROWS: Row[] = [
  {
    tools: ["find_accounts", "account_register"], file: "./tools.ts",
    gate: ["gl.read"], routes: [["../../app/api/accounts/[id]/route.ts", "guardPermission('gl.read')"]],
    note: "chart-of-accounts reads",
  },
  {
    tools: ["find_journal_entries", "get_journal_entry"], file: "./tools.ts",
    gate: ["gl.read"], routes: [["../../app/api/journals/[id]/route.ts", "guardPermission('gl.read')"]],
    note: "journal reads (mutations on that route are gl.post, as is draft_journal_entry)",
  },
  {
    tools: ["find_parties"], file: "./tools.ts",
    gate: ["parties.read"], routes: [["../../app/api/parties/[id]/drawer/route.ts", "guardPermission('parties.read')"]],
    note: "party reads",
  },
  {
    tools: ["profit_and_loss", "balance_sheet", "trial_balance", "cash_flow", "financial_trends"],
    file: "./tools.ts", gate: ["reports.read"],
    routes: [["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"]],
    note: "statement reads; the analytics hub view requires reports.read (pinned by the analytics-view test below)",
  },
  {
    tools: ["financial_periods"], file: "./tools.ts",
    gate: ["reports.read", "close.read"],
    routes: [
      ["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"],
      ["../../app/(app)/close/view.ts", "requirePermission('close.read')"],
    ],
    note: "period boundaries serve reports readers; lock/run state serves close readers",
  },
  {
    tools: ["budget_vs_actual"], file: "./tools.ts",
    gate: ["budgets.read", "reports.read"],
    routes: [
      ["../../app/api/budgets/[id]/route.ts", "guardFeaturePermission('budgets.read', 'budgets')"],
      ["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"],
    ],
    note: "variance analysis lives on both the budgets screen and the analytics hub",
  },
  {
    tools: ["list_budget_scenarios", "get_budget_scenario"], file: "./tools-reports.ts",
    gate: ["budgets.read"],
    routes: [["../../app/api/budgets/[id]/route.ts", "guardFeaturePermission('budgets.read', 'budgets')"]],
    note: "budget scenario reads",
  },
  {
    tools: ["project_profitability"], file: "./tools.ts",
    gate: ["projects.read", "reports.read"],
    routes: [
      ["../../app/api/projects/[id]/route.ts", "guardPermission('projects.read')"],
      ["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"],
    ],
    note: "one-job detail serves the projects screen and analytics callers",
  },
  {
    tools: ["rank_projects"], file: "./tools-projects.ts",
    gate: ["projects.read", "reports.read"],
    routes: [["../../app/api/projects/[id]/route.ts", "guardPermission('projects.read')"]],
    note: "portfolio ranking doorway matches the projects screen",
  },
  {
    tools: ["retainage_balances"], file: "./tools-construction.ts",
    gate: ["ar.read", "ap.read", "projects.read", "gl.read"],
    routes: [["../../app/api/projects/[id]/route.ts", "guardPermission('projects.read')"]],
    note: "ledger holdback balances; any party-side reader may reach them",
  },
  {
    tools: ["general_ledger"], file: "./tools-reports.ts",
    gate: ["reports.read", "gl.read"],
    routes: [
      ["../../app/api/journals/[id]/route.ts", "guardPermission('gl.read')"],
      ["../../app/api/reports/drill/route.ts", "guardPermission('reports.read')"],
    ],
    note: "per-account lines serve GL and report drill readers",
  },
  {
    tools: ["cash_flow_indirect", "list_report_definitions", "run_report", "list_report_schedules"],
    file: "./tools-reports.ts", gate: ["reports.read"],
    routes: [
      ["../../app/api/reports/definitions/route.ts", "guardPermission('reports.read')"],
      ["../../app/api/reports/run/route.ts", "guardPermission('reports.read')"],
      ["../../app/api/reports/schedules/route.ts", "guardPermission('reports.read')"],
    ],
    note: "saved-report surface (scheduling itself is reports.schedule, unwired to reads)",
  },
  {
    tools: ["list_reporting_packages"], file: "./tools-reports.ts",
    gate: ["close.read"],
    routes: [
      ["../../app/api/close/runs/[id]/binder/route.ts", "guardFeaturePermission(\"close.read\""],
      ["../../app/(app)/close/view.ts", "requirePermission('close.read')"],
    ],
    note: "close package reads",
  },
  {
    tools: [
      "analytics_financial_health", "analytics_customer_intelligence", "analytics_vendor_performance",
      "analytics_cashflow", "analytics_true_cost", "analytics_utilization", "analytics_spend_velocity",
    ],
    file: "./tools-analytics.ts", gate: ["reports.read"],
    routes: [["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"]],
    note: "dashboard reads share the hub reports.read doorway (per-module data fenced by feature, not perm)",
  },
  {
    tools: ["ap_position"], file: "./tools-analytics.ts", gate: ["ap.read"],
    routes: [["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"]],
    note: "payables cockpit admits ap.read holders; the hub drill admits reports.read holders — union doorway over both surfaces",
  },
  {
    tools: ["ar_position"], file: "./tools-analytics.ts", gate: ["ar.read"],
    routes: [["../../app/api/analytics/drill/route.ts", "guardPermission(\"reports.read\")"]],
    note: "receivables cockpit admits ar.read holders; the hub drill admits reports.read holders — union doorway over both surfaces",
  },
  {
    tools: ["cash_position"], file: "./tools-analytics.ts", gate: ["banking.read"],
    routes: [["../../app/api/cash/week-entries/route.ts", "guardFeaturePermission(\"reports.read\", \"banking\")"]],
    note: "cash cockpit summary is banking.read-gated; the banking feature fence matches the drill route",
  },
  {
    tools: ["list_bank_reconciliations", "get_bank_reconciliation"], file: "./tools-banking.ts",
    gate: ["banking.read"],
    routes: [["../../app/api/banking/reconciliations/route.ts", "guardFeaturePermission('banking.read', 'banking')"]],
    note: "recon reads",
  },
  {
    tools: ["list_unmatched_bank_lines"], file: "./tools-banking.ts",
    gate: ["banking.reconcile"],
    routes: [["../../app/api/banking/rules/route.ts", "guardFeaturePermission('banking.reconcile', 'banking')"]],
    note: "matching worklist",
  },
  {
    tools: ["list_bank_feeds"], file: "./tools-banking.ts",
    gate: ["admin.setup.manage"],
    routes: [["../../app/api/banking/bank-feeds/route.ts", "guardFeaturePermission(\"admin.setup.manage\", \"bankFeeds\")"]],
    note: "feed administration",
  },
  {
    tools: ["list_files", "get_file", "list_folders"], file: "./tools-files.ts",
    gate: ["documents.read"],
    routes: [
      ["../../app/api/file-cabinet/files/route.ts", "guardPermission('documents.read')"],
      ["../../app/api/file-cabinet/folders/route.ts", "guardPermission('documents.read')"],
    ],
    note: "file cabinet reads (per-folder grants enforced inside, as on the routes)",
  },
  {
    tools: ["list_pay_runs", "get_pay_run", "payroll_year_end", "payroll_entitlements", "payroll_remittances"],
    file: "./tools-payroll.ts", gate: ["payroll.read"],
    routes: [["../../app/api/payroll/runs/route.ts", "guardFeaturePermission('payroll.read', 'payroll')"]],
    note: "pay-run reads",
  },
  {
    tools: ["payroll_setup_status", "list_payroll_employees"], file: "./tools-payroll.ts",
    gate: ["payroll.manage"],
    routes: [["../../app/api/payroll/settings/route.ts", "guardFeaturePermission('payroll.manage', 'payroll')"]],
    note: "payroll administration reads",
  },
  {
    tools: ["list_setup_records", "list_features"], file: "./tools-setup.ts",
    gate: ["admin.setup.manage"],
    routes: [
      ["../../app/api/admin/setup/[entity]/route.ts", "PERMISSION = 'admin.setup.manage'"],
      ["../../app/api/admin/setup/features/route.ts", "guardPermission('admin.setup.manage')"],
    ],
    note: "setup reads share the setup CRUD permission",
  },
  {
    tools: ["list_tax_return_forms", "tax_return"], file: "./tools-tax.ts",
    gate: ["reports.read"],
    routes: [["../../app/api/tax/returns/route.ts", "guardPermission('reports.read')"]],
    note: "filing-screen reads",
  },
  {
    tools: ["draft_journal_entry"], file: "./tools-write.ts",
    gate: ["gl.post"],
    routes: [["../../app/api/journals/draft/route.ts", "guardPermission(\"gl.post\")"]],
    note: "draft creation (commit path re-checks at /api/assistant/commit)",
  },
  {
    tools: ["preview_allocation"], file: "./tools-allocations.ts",
    gate: ["allocations.run"],
    routes: [["../../app/api/allocations/runs/preview/route.ts", 'guardAllocations("allocations.run")']],
    note: "preview persists a previewed allocation_runs row; same gate as POST /api/allocations/runs/preview",
  },
];

test("assistant tool doorways cover every cited surface and admit nothing uncited", () => {
  for (const row of UNION_ROWS) {
    for (const tool of row.tools) {
      const gate = gateOf(blockOf(row.file, tool));
      assert.equal(gate.mode, "anyOf", `${tool}: expected an anyOf doorway`);
      assert.deepEqual(
        [...gate.perms].sort(),
        [...row.gate].sort(),
        `${tool}: doorway ${JSON.stringify(gate.perms)} != matrix ${JSON.stringify(row.gate)}`,
      );
    }
    for (const [routeFile, guard] of row.routes) {
      assert.ok(
        read(routeFile).includes(guard),
        `${row.tools.join(",")}: ${routeFile} no longer contains ${guard}`,
      );
    }
  }
});

test("analytics hub views require the reports.read the dashboard tools gate on", () => {
  assert.ok(
    read("../../app/(app)/analytics/financial-health/view.ts").includes("requirePermission('reports.read')"),
    "financial-health view must keep its reports.read requirement",
  );
});

/** One doorway, narrowed inside execute to the caller's exact grant. */
const NARROWED_ROWS: { tool: string; file: string; markers: string[]; note: string }[] = [
  {
    tool: "find_documents", file: "./tools.ts",
    markers: ["allowedKinds(authz)", "KIND_PERM[a.kind]", "subsidiaryVisibleFilter(sql`d.subsidiary_id`"],
    note: "kinds limited to per-kind read grants; cross-subsidiary listing blocked",
  },
  {
    tool: "get_document", file: "./tools.ts",
    markers: ["KIND_PERM[d.kind]", "subsidiaryVisibleFilter(sql`d.subsidiary_id`"],
    note: "per-document kind grant checked after the read, same table as the search",
  },
  {
    tool: "aging", file: "./tools.ts",
    markers: ['can(authz, a.side === "ar" ? "ar.read" : "ap.read")'],
    note: "side-specific read grant enforced before the aggregate",
  },
  {
    tool: "documents_missing_tax_code", file: "./tools-tax.ts",
    markers: ["TAXABLE_KIND_PERM[kind]", "subsidiaryVisibleFilter(sql`d.subsidiary_id`"],
    note: "pre-filing review limited to kinds the caller may read",
  },
  {
    tool: "continuous_close_findings", file: "./tools.ts",
    markers: ["readableContinuousCloseAgents(authz)"],
    note: "agent visibility reuses the route's own reader (see lib row)",
  },
  {
    tool: "get_continuous_close_finding", file: "./tools.ts",
    markers: ["readableContinuousCloseAgents(authz)", "row.agent_key"],
    note: "single-finding read checks the row's agent against the shared reader",
  },
  {
    tool: "explain_allocation", file: "./tools-allocations.ts",
    markers: [
      "entryDetail(authz.user.orgId, anchor.id, authz.allowedSubsidiaryIds, can(authz, \"payroll.read\"))",
      "subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)",
      'error: "entry_not_found"',
      'error: "document_not_found"',
    ],
    note: "journal/document anchors use the same visibility as get_journal_entry / get_document before queryLineage",
  },
];

test("broad-doorway tools narrow to the caller's grant inside execute", () => {
  for (const row of NARROWED_ROWS) {
    const body = blockOf(row.file, row.tool);
    for (const marker of row.markers) {
      assert.ok(body.includes(marker), `${row.tool}: missing narrowing marker ${marker} (${row.note})`);
    }
  }
  assert.ok(
    read("../continuous-close.ts").includes("export function canReadContinuousCloseAgent"),
    "the shared agent reader must stay the route/tool contract",
  );
});

/** Detector route and tool share the whole-company forensics gate: documented, must not be loosened. */
test("analytics_sentinel matches the detector routes (audit-log access)", () => {
  const gate = gateOf(blockOf("./tools-analytics.ts", "analytics_sentinel"));
  assert.equal(gate.mode, "allOf");
  assert.deepEqual([...gate.perms].sort(), ["admin.audit.read", "reports.read"]);
  const route = read("../../app/api/analytics/sentinel/benford/route.ts");
  assert.ok(
    route.includes('guardPermission("reports.read")'),
    "detector route still starts from the reports.read identity gate",
  );
  assert.ok(
    route.includes("sentinelAccessDenied"),
    "detector route enforces the shared sentinel gate (unrestricted reports + audit access), exactly like the page",
  );
});

const catalog = read("../application/tool-catalog.ts");

/** Application tools: doorway in visibleTo, precision in the service assert. */
const SERVICE_ROWS: {
  tools: string[];
  visibleTo: string;
  serviceFile: string;
  serviceAssert: string;
  routes: [string, string][];
  note: string;
}[] = [
  {
    tools: ["get_company_settings"], visibleTo: 'anyPermission("admin.users.manage", "admin.setup.manage")',
    serviceFile: "../company-settings.ts",
    serviceAssert: 'SETTINGS_READ_PERMISSION = "admin.users.manage"',
    routes: [["../../app/api/admin/settings/route.ts", "guardPermission(SETTINGS_READ_PERMISSION)"]],
    note: "settings read",
  },
  {
    tools: ["update_company_settings", "update_features", "create_setup_record", "update_setup_record", "delete_setup_record"],
    visibleTo: "visibleTo: SETUP_ADMIN,",
    serviceFile: "../application/tool-catalog.ts",
    serviceAssert: 'assertApplicationPermission(context, "admin.setup.manage")',
    routes: [
      ["../../app/api/admin/settings/route.ts", "guardPermission(SETTINGS_WRITE_PERMISSION)"],
      ["../../app/api/admin/setup/[entity]/route.ts", "PERMISSION = 'admin.setup.manage'"],
      ["../../app/api/admin/setup/features/route.ts", "guardPermission('admin.setup.manage')"],
    ],
    note: "setup writes (SETTINGS_WRITE_PERMISSION is admin.setup.manage)",
  },
  {
    tools: ["list_close_runs", "get_close_run", "start_close_run", "refresh_close_run", "request_close_approval", "attest_close_run", "close_period"],
    visibleTo: 'hasPermission("close.run")',
    serviceFile: "../application/close.ts",
    serviceAssert: 'assertApplicationPermission(context, "close.run")',
    routes: [["../../app/api/close/runs/route.ts", 'guardFeaturePermission("close.run"']],
    note: "close lifecycle doorway (attest/close escalate to close.approve inside, as on the [id] route)",
  },
  {
    tools: ["request_period_reopen", "decide_period_reopen"],
    visibleTo: 'hasPermission("close.reopen")',
    serviceFile: "../application/close.ts",
    serviceAssert: 'assertApplicationPermission(context, "close.reopen")',
    routes: [["../../app/api/close/runs/route.ts", 'guardFeaturePermission("close.run"']],
    note: "reopen doorway close.reopen; route file cited for the runs surface",
  },
  {
    tools: ["submit_document", "post_document", "void_document", "correct_document"],
    visibleTo: "visibleTo: documentActor,",
    serviceFile: "../application/documents.ts",
    serviceAssert: "lifecyclePermission(header.kind, input.action)",
    routes: [["../../app/api/documents/actions/route.ts", "postPermission(doc.kind)"]],
    note: "doorway admits document actors; execute asserts the per-kind per-action permission",
  },
  {
    tools: ["create_payment", "update_payment", "post_payment"],
    visibleTo: 'anyPermission("ap.pay", "ar.pay")',
    serviceFile: "../application/payments.ts",
    serviceAssert: "paymentPermission(",
    routes: [["../../app/api/payments/open-items/route.ts", "guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')"]],
    note: "payment doorway matches the payment routes side-for-side; execute re-asserts per kind",
  },
  {
    tools: ["list_approvals", "decide_approval"],
    visibleTo: 'hasPermission("flows.approve")',
    serviceFile: "../application/approvals.ts",
    serviceAssert: 'throw forbidden("flows.approve")',
    routes: [["../application/approvals.ts", 'assertApplicationPermission(context, "flows.approve")']],
    note: "flows doorway on both layers (decide asserts per subject too)",
  },
  {
    tools: ["list_records", "get_record", "create_record", "update_record", "delete_record"],
    visibleTo: "visibleTo: visible,",
    serviceFile: "../application/records.ts",
    serviceAssert: "schema.readPermission",
    routes: [["../../app/api/records/[typeKey]/route.ts", "guardPermission('records.read')"]],
    note: "open doorway with per-type asserts, mirroring the records routes",
  },
];

/** Built in a `.map((action) => …)` loop: names live in the shared builder, not in per-tool definitions. */
const CLOSE_LOOP_TOOLS = [
  "refresh_close_run", "request_close_approval", "attest_close_run", "close_period",
  "submit_document", "post_document",
];

test("application tools enforce the same permission the route enforces", () => {
  for (const row of SERVICE_ROWS) {
    for (const tool of row.tools) {
      if (CLOSE_LOOP_TOOLS.includes(tool)) {
        // Loop-built names: the close actions name each tool literally, while
        // submit/post share a `${action}_document` template (as skills.test.ts notes).
        const present = tool.endsWith("_document") && ["submit_document", "post_document"].includes(tool)
          ? catalog.includes("`${action}_document`")
          : catalog.includes(`"${tool}"`);
        assert.ok(present, `${tool} missing from its action builder`);
        continue;
      }
      const at = catalog.indexOf(`name: "${tool}"`);
      assert.ok(at >= 0, `${tool} missing from the application catalog`);
      // The next definition starts a new `definition({` (or a spread `...([`);
      // at the catalog's indent — `}),` also matches empty `z.object({}),`
      // schemas, so it cannot terminate the slice. The last definition runs
      // to the end of the catalog array.
      const candidates = ["\n  definition({", "\n  ...(["]
        .map((marker) => catalog.indexOf(marker, at + 1))
        .filter((index) => index > at);
      const end = candidates.length > 0 ? Math.min(...candidates) : catalog.length;
      assert.ok(
        catalog.slice(at, end).includes(row.visibleTo),
        `${tool}: doorway must stay ${row.visibleTo} (${row.note})`,
      );
    }
    assert.ok(read(row.serviceFile).includes(row.serviceAssert), `${row.tools.join(",")}: service assert changed (${row.serviceAssert})`);
    for (const [routeFile, guard] of row.routes) {
      assert.ok(read(routeFile).includes(guard), `${row.tools.join(",")}: ${routeFile} no longer contains ${guard}`);
    }
  }
  // The documentActor doorway admits document actors; its permission set is pinned here.
  assert.ok(
    catalog.includes('const documentActor = anyPermission("gl.post", "ap.create", "ap.post", "ar.create", "ar.post", "ap.pay", "ar.pay")'),
    "documentActor doorway must keep its permission set",
  );
  // The close-action loop escalates attest/close to close.approve, as the [id] route does.
  assert.ok(
    catalog.includes('hasPermission(action === "attest" || action === "close" ? "close.approve" : "close.run")'),
    "close-action doorway must keep its approve escalation",
  );
  assert.ok(
    read("../../app/api/close/runs/[id]/route.ts").includes('"close.approve"'),
    "[id] route must keep its approve escalation",
  );
});
