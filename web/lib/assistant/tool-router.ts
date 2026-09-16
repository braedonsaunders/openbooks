import type { ToolResult, ToolTier } from "./types";

/**
 * Context-efficient tool loading: which chat-payload slice each tool belongs
 * to, and which slices a turn pre-activates before the model sees anything.
 *
 * The full catalog stays REGISTERED with the AI SDK (typed, instant
 * activation); `prepareStep` only SENDS core ∪ activated ∪ pre-routed
 * definitions (verified: the SDK filters the per-step request payload by
 * `activeTools`). Tier never changes visibility — permission gates and
 * feature flags still decide what a caller may use — and the MCP surface
 * ignores tiers entirely.
 *
 * This module is deliberately pure (no server imports) so the routing table
 * is unit-testable with the plain Node runner.
 */

/** A tool with a feature flag lives in the module named by that flag. */
export function moduleOfTool(name: string, feature?: string | null): string {
  if (feature) return feature;
  return CORE_TOOL_MODULES[name] ?? "core";
}

/**
 * Module for every assistant/application tool WITHOUT a feature flag.
 * A tool missing here falls back to "core" (always sent) — the budget test
 * pins the core payload, so a new unmapped tool fails loudly there until it
 * gets an explicit module.
 */
export const CORE_TOOL_MODULES: Record<string, string> = {
  // Always-on chat primitives.
  whoami: "core",
  describe_capabilities: "core",
  find_tools: "core",
  // General ledger, books, statements, documents, parties.
  find_accounts: "ledger",
  account_register: "ledger",
  find_journal_entries: "ledger",
  get_journal_entry: "ledger",
  find_documents: "ledger",
  get_document: "ledger",
  find_parties: "ledger",
  profit_and_loss: "ledger",
  balance_sheet: "ledger",
  trial_balance: "ledger",
  aging: "ledger",
  aging_detail: "ledger",
  list_open_items: "ledger",
  cash_flow: "ledger",
  cash_flow_indirect: "ledger",
  financial_trends: "ledger",
  general_ledger: "ledger",
  partner_statement: "ledger",
  party_concentration: "ledger",
  ap_position: "ledger",
  ar_position: "ledger",
  list_recurring_schedules: "ledger",
  get_vitals: "ledger",
  draft_journal_entry: "ledger",
  // Analytics dashboards.
  analytics_financial_health: "analytics",
  analytics_customer_intelligence: "analytics",
  analytics_vendor_performance: "analytics",
  analytics_cashflow: "analytics",
  analytics_true_cost: "analytics",
  analytics_utilization: "analytics",
  analytics_spend_velocity: "analytics",
  analytics_sentinel: "analytics",
  // Indirect tax filing.
  list_tax_return_forms: "tax",
  tax_return: "tax",
  documents_missing_tax_code: "tax",
  // Period close + approvals.
  financial_periods: "close",
  get_close_run_status: "close",
  list_period_locks: "close",
  list_period_reopen_requests: "close",
  list_close_runs: "close",
  get_close_run: "close",
  start_close_run: "close",
  refresh_close_run: "close",
  request_close_approval: "close",
  attest_close_run: "close",
  close_period: "close",
  request_period_reopen: "close",
  decide_period_reopen: "close",
  list_approvals: "close",
  decide_approval: "close",
  // Report engine.
  list_report_definitions: "reports",
  run_report: "reports",
  list_report_schedules: "reports",
  list_reporting_packages: "reports",
  // Setup + company settings.
  list_setup_entities: "setup",
  list_setup_records: "setup",
  list_features: "setup",
  get_company_settings: "setup",
  update_company_settings: "setup",
  update_features: "setup",
  create_setup_record: "setup",
  update_setup_record: "setup",
  delete_setup_record: "setup",
  // Org administration.
  list_users: "admin",
  list_roles: "admin",
  search_audit_log: "admin",
  get_outbox_status: "admin",
  // File cabinet.
  list_files: "files",
  get_file: "files",
  list_folders: "files",
  // Document + payment lifecycle mutations.
  submit_document: "documents",
  post_document: "documents",
  post_journal: "documents",
  void_document: "documents",
  correct_document: "documents",
  create_payment: "documents",
  update_payment: "documents",
  post_payment: "documents",
  // Records platform + page layouts.
  list_record_types: "records",
  list_records: "records",
  get_record: "records",
  create_record: "records",
  update_record: "records",
  delete_record: "records",
  describe_page_layout_vocabulary: "records",
  describe_page_layout: "records",
  list_page_layouts: "records",
  validate_page_layout: "records",
  preview_page_layout: "records",
  set_page_layout: "records",
  list_page_layout_history: "records",
  restore_page_layout: "records",
  clear_page_layout: "records",
  // Feature-less tools owned by a flagged module's domain.
  search_items: "inventory",
  get_item: "inventory",
  list_currencies: "multiCurrency",
};

/** True for tools that ride every chat step. Absent tier means module. */
export function isCoreTier(tier?: ToolTier): boolean {
  return tier === "core";
}

/**
 * Keyword/synonym table: user words that pre-activate a module for the turn.
 * Vendor-neutral domain language only — no vendor, org, or install-specific
 * terms. Single words match on word boundaries; phrases match as substrings.
 */
export const MODULE_KEYWORDS: Record<string, string[]> = {
  ledger: [
    "account", "accounts", "journal", "ledger", "invoice", "invoices", "bill",
    "bills", "vendor", "vendors", "customer", "customers", "receivable",
    "payable", "aging", "cash flow", "partner statement", "account register",
    "concentration", "dso", "balance", "general ledger", "trial balance",
    "profit", "loss", "income", "vitals", "recurring", "entry", "entries",
    "statements", "ar", "ap", "overdue", "position",
  ],
  analytics: [
    "analytic", "dashboard", "financial health", "sentinel", "suspicious",
    "duplicate", "fraud", "anomaly", "anomalies", "forecast", "velocity",
    "utilization", "true cost", "intelligence", "benchmark", "ratio", "trend",
  ],
  tax: [
    "tax", "gst", "hst", "vat", "pst", "qst", "sales tax", "filing",
    "tax return", "itc", "input tax", "tax code",
  ],
  close: [
    "close", "closing", "closed", "lock", "locked", "period", "checklist",
    "reopen", "approval", "approvals", "attest", "year end", "year-end",
    "month end", "month-end",
  ],
  reports: ["report", "reports", "custom report", "report schedule", "reporting package", "save view"],
  setup: ["setting", "settings", "setup", "feature", "features", "company settings", "control account", "fiscal year"],
  admin: ["user", "users", "role", "roles", "permission", "audit log", "audit", "outbox", "access", "api key"],
  files: ["file", "files", "upload", "attachment", "folder", "cabinet"],
  inventory: ["inventory", "stock", "item", "items", "warehouse", "sku", "on hand", "quantity"],
  orders: ["order", "orders", "sales order", "purchase order", "backorder", "fulfil", "fulfill", "shipment"],
  banking: ["bank", "banks", "cash", "reconcil", "bank feed", "unmatched", "bank line", "bank statement", "clearing"],
  budgets: ["budget", "budgets", "variance", "vs actual", "budget scenario", "budget workspace"],
  projects: [
    "project", "projects", "job", "jobs", "contract", "contracts", "margin",
    "wip", "retainage", "holdback", "change order", "progress billing",
    "cost budget", "unbilled", "billing",
  ],
  crm: ["opportunity", "opportunities", "lead", "leads", "deal", "deals", "pipeline", "crm", "crm account", "activities", "activity"],
  payroll: [
    "payroll", "pay run", "payrun", "salary", "salaries", "wage", "wages",
    "payslip", "remittance", "cra", "ei", "cpp", "t4", "roe", "deduction",
    "deductions", "employee", "employees", "entitlement",
  ],
  expenses: ["expense", "expenses", "receipt", "per diem", "mileage", "expense report", "reimbursement"],
  fixedAssets: ["asset", "depreciation", "depreciate", "capital", "cca", "tax pool", "disposal"],
  equipment: ["equipment", "maintenance"],
  timeTracking: ["timesheet", "time entry", "time tracking", "hours"],
  propertyManagement: ["property", "lease", "tenant", "rent", "landlord", "rent roll"],
  subscriptionBilling: ["subscription", "mrr", "churn", "subscription plan"],
  fieldTickets: ["field ticket"],
  subcontracts: ["subcontract", "subcontractor", "sub contract"],
  wipBilling: ["wip", "prebill", "pre-bill", "schedule of values"],
  multiCurrency: ["currency", "fx", "forex", "exchange rate", "revalu", "consolidation"],
  multiSubsidiary: ["subsidiary", "subsidiaries", "consolidation", "eliminat"],
  continuousClose: ["continuous close", "close finding", "control finding"],
  advancedClose: ["close package"],
  apiAccess: ["api access"],
  bankFeeds: ["bank feed"],
  apps: ["app package", "app draft", "manifest"],
  records: ["records", "record type", "custom field", "page layout", "custom record"],
  documents: ["payment", "payments", "pay vendor", "pay bill", "pay invoice", "post", "posted", "posting", "void", "correction", "submit", "refund"],
};

function keywordPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Single words match on boundaries ("pay" must not fire on "payroll");
  // phrases match as substrings.
  return keyword.includes(" ") ? new RegExp(escaped, "i") : new RegExp(`\\b${escaped}\\b`, "i");
}

const MODULE_PATTERNS: { module: string; patterns: RegExp[] }[] = Object.entries(MODULE_KEYWORDS).map(
  ([module, keywords]) => ({ module, patterns: keywords.map(keywordPattern) }),
);

/**
 * Derive modules to pre-activate from the latest user message plus the
 * modules of previous assistant tool calls in the conversation (so a
 * follow-up keeps the context it already used). Default: core only
 * (empty array — the caller always sends core-tier tools).
 */
export function preRouteModules(
  message: string,
  priorToolNames: readonly string[] = [],
  resolveModule: (toolName: string) => string = () => "core",
): string[] {
  const active = new Set<string>();
  for (const { module, patterns } of MODULE_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(message))) active.add(module);
  }
  for (const toolName of priorToolNames) {
    const module = resolveModule(toolName);
    if (module !== "core") active.add(module);
  }
  return [...active].sort();
}

/** Per-turn activation scope, threaded through `prepareStep`. */
export type TurnScope = {
  /** Modules the pre-router activated from the user message. */
  preRouted: string[];
  /** Modules find_tools activated mid-turn. */
  activated: string[];
};

export function createTurnScope(preRouted: readonly string[] = []): TurnScope {
  return { preRouted: [...preRouted], activated: [] };
}

export function activateTurnModules(scope: TurnScope, modules: readonly string[]): void {
  for (const module of modules) {
    if (module !== "core" && !scope.activated.includes(module)) scope.activated.push(module);
  }
}

/**
 * Names the model may see this step: core-tier tools plus every tool whose
 * module was pre-routed or activated. Pure over a caller-supplied catalog
 * snapshot so tests never need the registry.
 */
export function resolveActiveToolNames(
  catalog: readonly { name: string; tier?: ToolTier; module: string }[],
  scope: Pick<TurnScope, "preRouted" | "activated">,
): string[] {
  const active = new Set([...scope.preRouted, ...scope.activated]);
  return catalog
    .filter((tool) => isCoreTier(tool.tier) || active.has(tool.module))
    .map((tool) => tool.name);
}

/**
 * The find_tools result shape the chat loop activates on. Kept here (pure)
 * so the registry can read activation modules without importing the
 * server-only tool definition it wraps.
 */
export type FindToolsData = {
  tools: { name: string; blurb: string; module: string }[];
  modules: string[];
  total: number;
};

/** Non-core modules a find_tools result activates; empty when it failed. */
export function findToolsModules(result: ToolResult): string[] {
  if (!result.ok) return [];
  const data = result.data as Partial<FindToolsData> | null | undefined;
  if (!data || !Array.isArray(data.modules)) return [];
  const modules = data.modules.filter((m): m is string => typeof m === "string" && m !== "core");
  return [...new Set(modules)];
}

/**
 * Rank catalog entries against a find_tools query. Name hits outrank module
 * hits; description hits only order within those. Returns at most `limit`.
 */
export function matchTools(
  catalog: readonly { name: string; blurb: string; module: string }[],
  query: string,
  limit: number,
): { name: string; blurb: string; module: string }[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const scored = catalog
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const blurb = tool.blurb.toLowerCase();
      const module = tool.module.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (name.includes(token)) score += 3;
        if (module.includes(token)) score += 2;
        if (blurb.includes(token)) score += 1;
      }
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.tool);
}
