import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Authz } from "../authz";
import type { SessionUser } from "../auth";

// Same module-graph shim as the other assistant DB tests: the registry is
// server-only and the transitively imported app modules use the `@/` alias.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier.startsWith("@/")) {
      const path = root + "web/" + specifier.slice(2);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
      }
      return nextResolve(path, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { ASSISTANT_TOOLS, executeAssistantTool } = await import("./registry");
const { MAX_ROW_STRING } = await import("./tools-shared");

/**
 * Tool contract harness (shard a06). Every READ/SEARCH assistant tool is
 * called with its minimal valid input through `executeAssistantTool` — the
 * same entry the chat loop and the MCP server share — against a scratch org,
 * and must honour the tool contract:
 *
 * - never throws (a failure is `{ ok: false }`, never an exception),
 * - `{ ok: true }` with data, or a DOCUMENTED `{ ok: false, error }`:
 *   feature-off (`*_feature_disabled`, `feature_disabled`) or an empty-store
 *   refusal (`*_not_found`, `tax_return: …` with no forms configured),
 * - the result JSON-round-trips byte-identically (no Dates, BigInts,
 *   undefined, or functions — the MCP transport would mangle those),
 * - the result fits the per-turn output budget (24 KB).
 *
 * Tools over budget get a lowered `limit` default or a compact projection —
 * fix them, do not raise the budget. Per-tool sizes are printed by the
 * `reports per-tool output sizes` case and recorded in the fleet ledger.
 */

const OUTPUT_BUDGET_BYTES = 24 * 1024;

const DB_ONLY = { skip: !process.env.OPENBOOKS_DB_URL };

/** A fully-permissioned reader: every gate a read tool declares. A
 *  `forbidden` for this actor is a harness failure, never an expectation. */
const READER_PERMS = [
  "assistant.use",
  "gl.read",
  "ap.read",
  "ar.read",
  "expenses.read",
  "payroll.read",
  "payroll.manage",
  "projects.read",
  "parties.read",
  "time.read",
  "reports.read",
  "budgets.read",
  "close.read",
  "banking.read",
  "banking.reconcile",
  "documents.read",
  "documents.manage",
  "items.read",
  "assets.read",
  "crm.opportunities.read",
  "crm.accounts.read",
  "crm.activities.read",
  "crm.forecasts.read",
  "close.reopen",
  "periods.manage",
  "admin.setup.manage",
  "admin.audit.read",
  "admin.users.manage",
  "admin.roles.manage",
  "api.keys.manage",
  "data.export",
  "data.import",
  "admin.sandboxes.manage",
  "admin.customization.manage",
  "allocations.read",
  "hrm.employment.read",
  // The headcount plan (0192) has its own read grant; the harness reader
  // holds every read grant so every read tool runs rather than refusing.
  "hrm.position.read",
];

/** Empty-store refusals: stable error codes on an org with no transactions. */
const EMPTY_STORE: Record<string, string> = {
  get_journal_entry: "entry_not_found",
  get_document: "document_not_found",
  run_report: "report_not_found",
  get_budget_scenario: "budget_scenario_not_found",
  get_bank_reconciliation: "reconciliation_not_found",
  get_pay_run: "pay_run_not_found",
  payroll_entitlements: "employee_not_found",
  get_file: "file_not_found",
  get_pdf_template: "template_not_found",
  get_continuous_close_finding: "finding_not_found",
  get_opportunity: "opportunity_not_found",
  get_crm_account: "crm_account_not_found",
  get_crm_activity: "crm_activity_not_found",
  get_subscription: "subscription_not_found",
  get_lease: "lease_not_found",
  get_timesheet_week: "employee_not_found",
  project_time: "project_not_found",
  unbilled_time: "project_not_found",
  get_field_ticket: "field_ticket_not_found",
  get_expense_report: "expense_report_not_found",
  get_close_run_status: "close_run_not_found",
  get_consolidation_view: "period_not_found",
  get_budget_workspace: "budget_not_found",
  get_item: "not found",
  get_order: "not found",
  get_asset: "not found",
  get_equipment: "not found",
  get_subcontract: "not found",
  get_wip_prebill: "not found",
};

const FEATURE_OFF = new Set([
  "bank_feeds_feature_disabled",
  "feature_disabled",
  "multi_currency_feature_disabled",
  "budgets_feature_disabled",
  "allocations_feature_disabled",
  "hrm_feature_disabled",
  "api_access_feature_disabled",
]);

function readerAuthz(orgId: string): Authz {
  const userId = randomUUID();
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "Contract harness",
    email: "contract-harness@scratch.test",
    roles: [{ key: "contract-reader", name: "Contract reader" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(READER_PERMS), allowedSubsidiaryIds: null };
}

/** Fail on values the JSON transport silently drops or mangles (functions,
 *  symbols, bigints). `undefined` props and Dates have a stable wire reading
 *  and are allowed. */
function assertNonJsonClean(value: unknown, tool: string, path = "$"): void {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    assert.fail(`tool ${tool} result holds a non-JSON ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNonJsonClean(entry, tool, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertNonJsonClean(entry, tool, `${path}.${key}`);
    }
  }
}

function firstString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const bit of path) {
    if (Array.isArray(current)) current = current[Number(bit)];
    else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[bit];
    } else return null;
    if (current === undefined || current === null) return null;
  }
  return typeof current === "string" ? current : null;
}

/**
 * Optional modules the new coverage tools read from. The harness proves the
 * tools' real paths (not just their feature-off refusals), so the scratch
 * org switches these on with the same settings write the feature-fence tests
 * use — reads need no installed baseline beyond the flag.
 */
const HARNESS_FEATURES = [
  "crm",
  "subscriptionBilling",
  "inventory",
  "orders",
  "fixedAssets",
  "equipment",
  "subcontracts",
  "wipBilling",
  "propertyManagement",
  "timeTracking",
  "fieldTickets",
  "projects",
  "expenses",
  "multiCurrency",
  "multiSubsidiary",
  "apiAccess",
];

test("assistant read-tool contract harness", DB_ONLY, async (t) => {
  const org = await createScratchOrg();
  const sizes: { tool: string; bytes: number; outcome: string }[] = [];
  try {
    const flags = Object.fromEntries(HARNESS_FEATURES.map((key) => [key, true]));
    // The registry import replaces the test bypass process-wide, so this
    // seed UPDATE must carry explicit bypass scope: unscoped it matches zero
    // rows and every module-gated tool refuses with *_feature_disabled.
    await withBypassContext(() => db.execute(sql`
      update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||${JSON.stringify(flags)}::jsonb)
      where id = ${org.orgId}
    `));
    const authz = readerAuthz(org.orgId);
    await withOrgContext(org.orgId, async () => {
      // Resolve seed-dependent ids from the scratch org's own list tools.
      const accounts = await executeAssistantTool(authz, "find_accounts", {});
      assert.equal(accounts.ok, true, JSON.stringify(accounts));
      const accountId = firstString(accounts, ["data", "items", "0", "id"]);
      assert.ok(accountId, "scratch org seeds no accounts");
      const parties = await executeAssistantTool(authz, "find_parties", {});
      assert.equal(parties.ok, true, JSON.stringify(parties));
      const partyId = firstString(parties, ["data", "items", "0", "id"]) ?? randomUUID();

      const period = { period: "this_fiscal_year_to_date" };
      const inputs: Record<string, Record<string, unknown>> = {
        account_register: { accountId },
        aging: { side: "ar" },
        list_open_items: { side: "ar" },
        aging_detail: { side: "ar" },
        partner_statement: { side: "ar", partyId, ...period },
        balance_sheet: { asOf: "2026-07-31" },
        trial_balance: { asOf: "2026-07-31" },
        profit_and_loss: period,
        cash_flow: period,
        party_concentration: { side: "customer", ...period },
        tax_return: { formCode: "NOPE", ...period },
        documents_missing_tax_code: period,
        analytics_financial_health: period,
        analytics_customer_intelligence: period,
        analytics_vendor_performance: period,
        analytics_true_cost: period,
        analytics_utilization: period,
        analytics_spend_velocity: period,
        analytics_sentinel: period,
        general_ledger: period,
        cash_flow_indirect: period,
        run_report: { definitionId: randomUUID() },
        get_budget_scenario: { scenarioId: randomUUID() },
        get_journal_entry: { entryId: randomUUID() },
        get_document: { documentId: randomUUID() },
        get_bank_reconciliation: { reconciliationId: randomUUID() },
        get_pay_run: { documentId: randomUUID() },
        payroll_year_end: { taxYear: 2026 },
        payroll_entitlements: { employeePartyId: randomUUID() },
        payroll_remittances: { fromDate: "2026-01-01", toDate: "2026-12-31" },
        get_file: { id: randomUUID() },
        get_pdf_template: { id: randomUUID() },
        get_continuous_close_finding: { findingId: randomUUID() },
        list_setup_records: { entityKey: "extension-settings" },
        get_opportunity: { opportunityId: randomUUID() },
        get_crm_account: { partyId: randomUUID() },
        get_crm_activity: { activityId: randomUUID() },
        get_subscription: { subscriptionId: randomUUID() },
        get_lease: { leaseId: randomUUID() },
        get_timesheet_week: { employeePartyId: randomUUID(), week: "2026-09-16" },
        project_time: { projectId: randomUUID(), dimension: "employee" },
        unbilled_time: { projectId: randomUUID() },
        get_field_ticket: { ticketId: randomUUID() },
        get_expense_report: { reportId: randomUUID() },
        get_item: { id: randomUUID() },
        get_order: { kind: "sales_order", id: randomUUID() },
        get_asset: { id: randomUUID() },
        asset_tax_pools: { taxYear: 2025 },
        get_equipment: { id: randomUUID() },
        get_subcontract: { id: randomUUID() },
        get_wip_prebill: { id: randomUUID() },
        get_close_run_status: { runId: randomUUID() },
        hrm_employment_as_of: { employmentId: randomUUID(), asOf: "2026-06-15" },
        get_allocation_rule: { ruleId: randomUUID() },
        preview_driver_vector: { driverId: randomUUID(), period: "this_fiscal_year_to_date" },
        preview_allocation: { ruleId: randomUUID(), period: "this_fiscal_year_to_date" },
        explain_allocation: { journalEntryId: randomUUID() },
        list_fx_rates: { fromCurrency: "USD", toCurrency: "CAD" },
        get_consolidation_view: { periodId: randomUUID() },
        get_budget_workspace: { scenarioId: randomUUID() },
      };

      const readTools = ASSISTANT_TOOLS.filter((tool) => tool.category !== "write");
      assert.ok(readTools.length >= 60, `read catalog looks gutted (${readTools.length} tools)`);
      for (const tool of readTools) {
        const args = inputs[tool.name] ?? {};
        await t.test(`${tool.name} honours the tool contract`, async () => {
          // Production validates inputs against the tool's own schema before
          // executing (AI SDK / MCP SDK); the harness does the same so a
          // red test means the harness input is wrong, not the tool.
          tool.inputSchema.parse(args);
          let result: unknown;
          try {
            result = await executeAssistantTool(authz, tool.name, args);
          } catch (error) {
            assert.fail(`tool ${tool.name} threw instead of returning { ok: false }: ${String(error).slice(0, 200)}`);
          }
          const record = result as { ok: boolean; data?: unknown; error?: unknown; note?: unknown };
          assert.equal(typeof record.ok, "boolean", `tool ${tool.name} returned no ok flag`);
          if (record.ok) {
            assert.ok("data" in record, `tool ${tool.name} returned ok without data`);
          } else {
            const error = record.error;
            const documented =
              (typeof error === "string" && FEATURE_OFF.has(error)) ||
              EMPTY_STORE[tool.name] === error ||
              (tool.name === "tax_return" && typeof error === "string" && error.startsWith("tax_return: "));
            assert.ok(
              documented,
              `tool ${tool.name} refused with an undocumented error: ${JSON.stringify(error)}`,
            );
          }
          // Wire-accurate JSON: the MCP transport JSON-encodes results, so
          // stringify must not throw (BigInt) and the encoded text must be
          // stable (no values that silently change shape on the wire).
          // `undefined` props (e.g. an absent `note`) and `-0` amounts are
          // wire-harmless: the text is identical after a round trip.
          let json: string;
          try {
            json = JSON.stringify(result);
          } catch {
            assert.fail(`tool ${tool.name} result is not JSON-serializable`);
          }
          assert.equal(
            JSON.stringify(JSON.parse(json) as unknown),
            json,
            `tool ${tool.name} result changes shape across a JSON round trip`,
          );
          assertNonJsonClean(result, tool.name);
          const bytes = Buffer.byteLength(json, "utf8");
          sizes.push({ tool: tool.name, bytes, outcome: record.ok ? "ok" : String(record.error) });
          assert.ok(
            bytes <= OUTPUT_BUDGET_BYTES,
            `tool ${tool.name} result is ${bytes} bytes (budget ${OUTPUT_BUDGET_BYTES}); lower its limit default or compact the projection`,
          );
        });
      }

      await t.test("range tools refuse an empty input with a stable error (never a throw)", async () => {
        const rangeTools = [
          "profit_and_loss",
          "cash_flow",
          "party_concentration",
          "tax_return",
          "documents_missing_tax_code",
          "analytics_financial_health",
          "analytics_customer_intelligence",
          "analytics_vendor_performance",
          "analytics_true_cost",
          "analytics_utilization",
          "analytics_spend_velocity",
          "analytics_sentinel",
          "general_ledger",
          "cash_flow_indirect",
          "partner_statement",
        ];
        for (const name of rangeTools) {
          const result = await executeAssistantTool(authz, name, {});
          assert.deepEqual(result, { ok: false, error: "period_or_date_range_required" }, name);
        }
      });

      await t.test("reports per-tool output sizes (recorded in the fleet ledger)", () => {
        const rows = [...sizes].sort((a, b) => b.bytes - a.bytes);
        for (const row of rows) {
          console.log(`[contract] ${row.tool}: ${row.bytes} bytes (${row.outcome})`);
        }
        const over = rows.filter((row) => row.bytes > OUTPUT_BUDGET_BYTES);
        assert.equal(over.length, 0, `over-budget tools: ${over.map((row) => row.tool).join(", ")}`);
        const widest = rows.filter((row) => row.bytes > MAX_ROW_STRING * 10);
        console.log(`[contract] ${rows.length} tools measured, ${widest.length} above ${MAX_ROW_STRING * 10} bytes`);
      });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
