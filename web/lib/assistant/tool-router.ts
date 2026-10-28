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

/** Large feature-backed domains can expose focused discovery slices. */
const FEATURE_MODULE_OVERRIDES: Record<string, string> = {
  list_stock_counts: "inventory_counts",
  get_stock_count: "inventory_counts",
  create_stock_count: "inventory_counts",
  start_stock_count: "inventory_counts",
  record_stock_count_quantity: "inventory_counts",
  record_second_stock_count: "inventory_counts",
  request_stock_count_recount: "inventory_counts",
  submit_stock_count_for_review: "inventory_counts",
  return_stock_count_to_counting: "inventory_counts",
  set_stock_count_date: "inventory_counts",
  post_stock_count: "inventory_counts",
  cancel_stock_count: "inventory_counts",
  get_warehouse_execution_task: "warehouse_execution",
  suggest_receipt_execution: "warehouse_execution",
  suggest_warehouse_putaway: "warehouse_execution",
  suggest_count_execution: "warehouse_execution",
  confirm_warehouse_execution_task: "warehouse_execution",
  list_inventory_transfer_orders: "inventory_transfers",
  list_landed_cost_vouchers: "inventory_transfers",
  create_inventory_transfer_order: "inventory_transfers",
  ship_inventory_transfer_order: "inventory_transfers",
  receive_inventory_transfer_order: "inventory_transfers",
  post_landed_cost_voucher: "inventory_transfers",
  reverse_landed_cost_voucher: "inventory_transfers",
  receive_inventory_stock: "inventory_movements",
  issue_inventory_stock: "inventory_movements",
  adjust_inventory_stock: "inventory_movements",
  transfer_inventory_stock: "inventory_movements",
  build_assembly_stock: "inventory_movements",
  post_landed_cost_adjustment: "inventory_movements",
  disassemble_assembly_stock: "inventory_movements",
  reverse_inventory_movement: "inventory_movements",
  ensure_item_lot: "inventory_movements",
  ensure_item_serial: "inventory_movements",
  set_stock_hold: "inventory_movements",
  move_consignment_stock: "inventory_movements",
  list_inventory_shortfalls: "inventory_accounting",
  attribute_inventory_shortfall_account: "inventory_accounting",
};

/** Feature flags control visibility; focused module slices control discovery. */
export function moduleOfTool(name: string, feature?: string | null): string {
  if (feature) return FEATURE_MODULE_OVERRIDES[name] ?? feature;
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
  close_period: "close",
  request_period_reopen: "close",
  submit_period_reopen: "close",
  list_approvals: "close",
  decide_approval: "close",
  // Report engine.
  list_report_definitions: "reports",
  run_report: "reports",
  list_report_schedules: "reports",
  list_reporting_packages: "reports",
  nl_report: "reports",
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
  return_document_to_draft: "documents",
  withdraw_document_submission: "documents",
  retry_document_posting_effects: "documents",
  correct_receipt_remainder: "documents",
  match_vendor_bill_lines: "documents",
  list_vendor_bill_match_candidates: "documents",
  create_payment: "documents",
  update_payment: "documents",
  post_payment: "documents",
  // Records platform + page layouts.
  list_record_types: "records",
  list_custom_record_type_definitions: "records",
  get_custom_record_type_definition: "records",
  create_custom_record_type: "records",
  update_custom_record_type: "records",
  delete_custom_record_type: "records",
  publish_custom_record_type: "records",
  archive_custom_record_type: "records",
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
  // Migrating into these books: plan, connectors, imports, opening balances, go-live.
  get_migration_plan: "migration",
  list_migration_sources: "migration",
  list_import_templates: "migration",
  inspect_import_file: "migration",
  preview_opening_balances: "migration",
  run_cutover_checks: "migration",
  update_migration_plan: "migration",
  start_migration_run: "migration",
  set_connection_mirror: "migration",
  prepare_import: "migration",
  commit_import: "migration",
  draft_opening_balances: "migration",
  record_go_live: "migration",
  // Feature-less tools owned by a flagged module's domain.
  search_items: "inventory",
  get_item: "inventory",
  list_currencies: "multiCurrency",

  // Ledger and close commands.
  list_accounting_changes: "ledger",
  propose_provision_assessment: "ledger",
  list_close_setup_configuration: "ledger",
  save_fiscal_calendar: "ledger",
  generate_accounting_periods: "ledger",
  get_banking_close_status: "ledger",
  set_period_module_lock: "ledger",
  close_period_modules: "ledger",
  withdraw_period_reopen: "ledger",
  reclose_period_reopen: "ledger",
  extend_period_reopen: "ledger",
  create_recurring_schedule: "ledger",
  pin_account_group: "ledger",
  unpin_account_group: "ledger",
  run_recurring_schedule: "ledger",
  pause_recurring_schedule: "ledger",
  update_recurring_schedule: "ledger",
  delete_recurring_schedule: "ledger",
  list_operating_profile_choices: "ledger",
  get_operating_setup_journey: "ledger",
  publish_operating_profile: "ledger",
  save_operating_profile_scope: "ledger",
  submit_net_investment_reversal: "ledger",
  apply_net_investment_reversal: "ledger",
  reverse_net_investment_assessment: "ledger",
  delete_journal_draft: "ledger",
  assign_gl_audit_numbers: "ledger",
  run_due_journal_reversals: "ledger",

  // Treasury commands.
  list_payment_operation_configs: "banking",
  get_party_payment_setup: "banking",
  create_payment_format: "banking",
  create_payment_bank_profile: "banking",
  create_payment_schedule: "banking",
  create_payment_mandate: "banking",
  update_payment_format: "banking",
  update_payment_bank_profile: "banking",
  update_payment_schedule: "banking",
  update_payment_mandate: "banking",
  list_payment_runs: "documents",
  get_payment_run: "documents",
  create_payment_run: "documents",
  submit_payment_run: "documents",
  generate_payment_run_file: "documents",
  reprocess_payment_run_file: "documents",
  deliver_payment_run_file: "documents",
  post_payment_run: "documents",
  cancel_payment_run: "documents",
  rollback_payment_run: "documents",
  record_payment_instruction_settlement: "documents",
  resolve_payment_file_delivery: "documents",
  apply_open_credits: "documents",
  unapply_open_credit: "documents",
  write_off_invoice_balance: "documents",
  preview_statement_batch: "ledger",
  list_statement_batch_runs: "ledger",
  get_statement_batch_run: "ledger",
  create_statement_batch: "ledger",
  retry_statement_batch_run: "ledger",
  list_collections_worklist: "ledger",
  prepare_tax_filing_snapshot: "tax",
  file_tax_filing_snapshot: "tax",
  list_tax_filing_obligations: "tax",
  list_income_tax_provision_runs: "tax",
  compute_income_tax_provision: "tax",
  post_income_tax_provision: "tax",
  install_tax_return_packs: "tax",
  provision_tax_packs: "tax",
  list_tax_pack_installations: "tax",
  save_tax_rate_provider_config: "tax",
  get_tax_rate_provider_config: "tax",
  retry_tax_provider_transaction: "tax",
  list_tax_authority_connections: "tax",
  save_tax_authority_credentials: "tax",
  verify_tax_authority_connection: "tax",
  refresh_hmrc_tax_token: "tax",
  list_dunning_policies: "ledger",
  create_dunning_policy: "ledger",
  update_dunning_policy: "ledger",
  delete_dunning_policy: "ledger",
  run_dunning: "ledger",

  // Assets, leases, equity and funds commands.

  // Sales and fulfillment commands.

  // Purchasing commands.
  list_ap_capture_items: "purchasing",
  get_ap_capture_item: "purchasing",
  review_ap_capture_item: "purchasing",
  ingest_ap_capture_documents: "purchasing",
  reject_ap_capture_item: "purchasing",
  reprocess_ap_capture_item: "purchasing",
  materialize_ap_capture_item: "purchasing",
  list_ap_capture_mailboxes: "purchasing",
  create_ap_capture_mailbox: "purchasing",
  update_ap_capture_mailbox: "purchasing",
  transfer_ap_capture_mailbox_ownership: "purchasing",
  list_ap_capture_inbound_messages: "purchasing",
  list_inbox_items: "purchasing",
  create_direct_debit_run: "purchasing",
  update_vendor_compliance_settings: "purchasing",

  // Inventory and items commands.
  preview_item_price: "inventory",
  list_item_price_schedules: "inventory",
  create_item_price_schedule: "inventory",
  update_item_price_schedule: "inventory",
  delete_item_price_schedule: "inventory",

  // Manufacturing commands.

  // Subscriptions, usage and revenue commands.

  // Projects commands.

  // Time and resourcing commands.
  save_timesheet_week: "timeTracking",
  set_submitted_time_line_billable: "timeTracking",
  submit_timesheet_week: "timeTracking",
  reopen_timesheet_week: "timeTracking",
  withdraw_timesheet_week: "timeTracking",
  amend_time_entry: "timeTracking",
  amend_timesheet_week: "timeTracking",
  correct_unapproved_time_type: "timeTracking",
  list_schedule_boards: "timeTracking",
  list_schedule_board_assignments: "timeTracking",
  get_schedule_board_window: "timeTracking",
  change_schedule_board_entries: "timeTracking",
  publish_schedule_board: "timeTracking",
  send_schedule_distribution: "timeTracking",

  // Workforce records commands.

  // Talent commands.

  // Payroll commands.
  resolve_payroll_anomaly: "payroll",

  // CRM and service commands.
  assign_party_roles: "crm",
  create_party_bank_account: "crm",
  get_party_bank_accounts: "crm",
  get_party_relationships: "crm",
  retire_party_bank_account: "crm",
  remove_party_role: "crm",
  replace_party_relationships: "crm",
  send_party_statement: "crm",
  submit_party_bank_account_for_approval: "crm",
  update_party_bank_account: "crm",

  // Administration commands.
  list_transaction_forms: "admin",
  get_transaction_form: "admin",
  create_transaction_form: "admin",
  update_transaction_form: "admin",
  delete_transaction_form: "admin",
  get_org_email_settings: "admin",
  update_org_email_settings: "admin",
  test_org_email_transport: "admin",
  invite_user: "admin",
  set_user_active: "admin",
  assign_user_role: "admin",
  unassign_user_role: "admin",
  resend_user_invite: "admin",
  link_user_party: "admin",
  create_role: "admin",
  update_role_permissions: "admin",
  delete_role: "admin",
  list_pdf_templates: "admin",
  get_pdf_template: "admin",
  create_pdf_template: "admin",
  update_pdf_template: "admin",
  delete_pdf_template: "admin",
  preview_pdf_template: "admin",
  list_form_templates: "admin",
  get_form_template: "admin",
  create_form_template: "admin",
  update_form_template: "admin",
  publish_form_template: "admin",
  archive_form_template: "admin",
  get_org_navigation_config: "admin",
  update_org_navigation_config: "admin",
  list_backup_runs: "admin",
  run_backup_now: "admin",
  test_document_capture_provider: "admin",
  withdraw_approval_command: "admin",
  list_approval_delegations: "admin",
  revoke_approval_delegation: "admin",
  create_custom_field: "admin",
  update_custom_field: "admin",
  list_custom_fields: "admin",
  get_custom_field_definition: "admin",
  get_ai_settings: "admin",
  update_ai_settings: "admin",
  update_ai_agent_policy: "admin",
  test_ai_provider: "admin",
  list_ai_provider_models: "admin",
  list_platform_connections: "admin",
  create_platform_connection: "admin",
  update_platform_connection: "admin",
  delete_platform_connection: "admin",
  test_platform_connection: "admin",
  run_platform_connection: "admin",
  update_sftp_daemon: "admin",
  delete_admin_flow: "admin",
  create_quick_approval_flow: "admin",

  // Workspace commands.
  get_cashflow_categories: "analytics",
  replace_cashflow_categories: "analytics",
  get_financial_health_ratio_inputs: "analytics",
  update_financial_health_ratio_input: "analytics",
  bulk_move_file_cabinet_items: "files",
  bulk_delete_file_cabinet_items: "files",
  list_insight_cards: "analytics",
  get_insight_card: "analytics",
  create_insight_card: "analytics",
  update_insight_card: "analytics",
  delete_insight_card: "analytics",
  list_insight_dashboards: "analytics",
  get_insight_dashboard: "analytics",
  create_insight_dashboard: "analytics",
  update_insight_dashboard: "analytics",
  delete_insight_dashboard: "analytics",
  get_analytics_dashboard_config: "analytics",
  update_analytics_dashboard_config: "analytics",
  list_saved_report_shortcuts: "reports",
  export_data_rows: "migration",
  list_data_transfers: "migration",
  get_data_transfer: "migration",
  create_data_transfer: "migration",
  upload_data_transfer_part: "migration",
  manage_data_transfer: "migration",
  create_report_schedule: "reports",
  update_report_schedule: "reports",
  delete_report_schedule: "reports",
  delete_report_definition: "reports",
  update_report_definition: "reports",
  create_report_definition: "reports",
  clone_report_definition: "reports",
  list_saved_views: "reports",
  get_saved_view: "reports",
  create_saved_view: "reports",
  update_saved_view: "reports",
  delete_saved_view: "reports",
  run_saved_view: "reports",
  send_record_pdf_email: "documents",
  replace_file: "files",
  attach_file_to_record: "files",
  detach_file_from_record: "files",
  set_dashboard_pin: "analytics",
  publish_insight_card: "analytics",
  publish_insight_dashboard: "analytics",
  create_folder: "files",
  update_folder: "files",
  delete_folder: "files",
  restore_folder: "files",
  rename_file: "files",
  move_file: "files",
  delete_file: "files",
  restore_file: "files",
  list_file_grants: "files",
  grant_file_access: "files",
  revoke_file_access: "files",
  list_folder_grants: "files",
  grant_folder_access: "files",
  revoke_folder_access: "files",
  mark_notifications_read: "core",
  act_on_inbox_item: "close",
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
    "account",
    "accounts",
    "journal",
    "ledger",
    "invoice",
    "invoices",
    "bill",
    "bills",
    "vendor",
    "vendors",
    "customer",
    "customers",
    "receivable",
    "payable",
    "aging",
    "cash flow",
    "partner statement",
    "account register",
    "concentration",
    "dso",
    "balance",
    "general ledger",
    "trial balance",
    "profit",
    "loss",
    "income",
    "vitals",
    "recurring",
    "entry",
    "entries",
    "statements",
    "ar",
    "ap",
    "overdue",
    "position",
  ],
  analytics: [
    "analytic",
    "dashboard",
    "financial health",
    "sentinel",
    "suspicious",
    "duplicate",
    "fraud",
    "anomaly",
    "anomalies",
    "forecast",
    "velocity",
    "utilization",
    "true cost",
    "intelligence",
    "benchmark",
    "ratio",
    "trend",
  ],
  tax: [
    "tax",
    "gst",
    "hst",
    "vat",
    "pst",
    "qst",
    "sales tax",
    "filing",
    "tax return",
    "itc",
    "input tax",
    "tax code",
  ],
  close: [
    "close",
    "closing",
    "closed",
    "lock",
    "locked",
    "period",
    "checklist",
    "reopen",
    "approval",
    "approvals",
    "attest",
    "year end",
    "year-end",
    "month end",
    "month-end",
  ],
  reports: [
    "report",
    "reports",
    "custom report",
    "report schedule",
    "reporting package",
    "save view",
  ],
  setup: [
    "setting",
    "settings",
    "setup",
    "feature",
    "features",
    "company settings",
    "control account",
    "fiscal year",
  ],
  admin: [
    "user",
    "users",
    "role",
    "roles",
    "permission",
    "audit log",
    "audit",
    "outbox",
    "access",
    "api key",
  ],
  files: ["file", "files", "upload", "attachment", "folder", "cabinet"],
  inventory: ["inventory", "stock", "item", "items", "warehouse", "sku", "on hand", "quantity"],
  inventory_counts: ["stock count", "cycle count", "count variance", "count recount"],
  inventory_movements: [
    "inventory adjustment",
    "stock receipt",
    "stock issue",
    "stock transfer",
    "inventory movement",
    "consignment stock",
    "lot hold",
    "serial hold",
  ],
  inventory_transfers: [
    "inventory transfer order",
    "landed cost voucher",
    "landed cost allocation",
  ],
  warehouse_execution: ["warehouse execution", "putaway task", "receipt scan", "count scan"],
  inventory_accounting: ["inventory shortfall", "stock shortfall", "shortfall account"],
  orders: [
    "order",
    "orders",
    "sales order",
    "purchase order",
    "backorder",
    "fulfil",
    "fulfill",
    "shipment",
  ],
  fulfillment: [
    "pick list",
    "pick lists",
    "picking",
    "shipment",
    "shipments",
    "carrier",
    "tracking number",
    "tracking link",
  ],
  banking: [
    "bank",
    "banks",
    "cash",
    "reconcil",
    "bank feed",
    "unmatched",
    "bank line",
    "bank statement",
    "clearing",
  ],
  budgets: ["budget", "budgets", "variance", "vs actual", "budget scenario", "budget workspace"],
  projects: [
    "project",
    "projects",
    "job",
    "jobs",
    "contract",
    "contracts",
    "margin",
    "wip",
    "retainage",
    "holdback",
    "change order",
    "progress billing",
    "cost budget",
    "unbilled",
    "billing",
  ],
  crm: [
    "opportunity",
    "opportunities",
    "lead",
    "leads",
    "deal",
    "deals",
    "pipeline",
    "crm",
    "crm account",
    "activities",
    "activity",
  ],
  payroll: [
    "payroll",
    "pay run",
    "payrun",
    "salary",
    "salaries",
    "wage",
    "wages",
    "payslip",
    "remittance",
    "cra",
    "ei",
    "cpp",
    "t4",
    "roe",
    "deduction",
    "deductions",
    "employee",
    "employees",
    "entitlement",
  ],
  hrm: ["hrm", "headcount", "employment", "employments", "change request", "change requests"],
  expenses: [
    "expense",
    "expenses",
    "receipt",
    "per diem",
    "mileage",
    "expense report",
    "reimbursement",
  ],
  purchasing: [
    "purchase order",
    "purchase orders",
    "purchasing",
    "ap capture",
    "supplier document",
    "inbox",
    "approval worklist",
  ],
  fixedAssets: ["asset", "depreciation", "depreciate", "capital", "cca", "tax pool", "disposal"],
  equipment: ["equipment", "maintenance"],
  timeTracking: ["timesheet", "time entry", "time tracking", "hours"],
  propertyManagement: ["property", "lease", "tenant", "rent", "landlord", "rent roll"],
  subscriptionBilling: ["subscription", "mrr", "churn", "subscription plan"],
  fieldTickets: ["field ticket"],
  preBilling: ["wip", "prebill", "pre-bill", "schedule of values"],
  multiCurrency: ["currency", "fx", "forex", "exchange rate", "revalu", "consolidation"],
  multiSubsidiary: ["subsidiary", "subsidiaries", "consolidation", "eliminat"],
  continuousClose: ["continuous close", "close finding", "control finding"],
  allocations: [
    "allocation rule",
    "allocation rules",
    "cost allocation",
    "allocation run",
    "allocation driver",
    "cost driver",
    "apportion",
    "overhead allocation",
    "allocated cost",
    "allocation lineage",
  ],
  advancedClose: ["close package"],
  apiAccess: ["api access"],
  bankFeeds: ["bank feed"],
  apps: ["app package", "app draft", "manifest"],
  records: ["records", "record type", "custom field", "page layout", "custom record"],
  migration: [
    "migrate",
    "migrating",
    "migration",
    "mirror",
    "mirroring",
    "cutover",
    "cut over",
    "go live",
    "go-live",
    "opening balance",
    "opening balances",
    "import template",
    "import file",
    "conversion",
    "previous system",
    "old system",
    "connector",
    "switching",
  ],
  documents: [
    "payment",
    "payments",
    "pay vendor",
    "pay bill",
    "pay invoice",
    "post",
    "posted",
    "posting",
    "void",
    "correction",
    "submit",
    "refund",
  ],
};

function keywordPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Single words match on boundaries ("pay" must not fire on "payroll");
  // phrases match as substrings.
  return keyword.includes(" ") ? new RegExp(escaped, "i") : new RegExp(`\\b${escaped}\\b`, "i");
}

const MODULE_PATTERNS: { module: string; patterns: RegExp[] }[] = Object.entries(
  MODULE_KEYWORDS,
).map(([module, keywords]) => ({ module, patterns: keywords.map(keywordPattern) }));

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

/**
 * Tool names the assistant already called in this conversation, read off UI
 * message parts (static `tool-<name>` parts and `dynamic-tool` parts with a
 * toolName). The pre-router maps them back to modules so a follow-up keeps
 * the context it already used. Unknown shapes are ignored, never thrown on.
 */
export function priorToolNames(messages: readonly { role: string; parts?: unknown }[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (typeof part !== "object" || part === null) continue;
      const type = (part as { type?: unknown }).type;
      if (type === "dynamic-tool") {
        const name = (part as { toolName?: unknown }).toolName;
        if (typeof name === "string" && name) names.push(name);
      } else if (
        typeof type === "string" &&
        type.startsWith("tool-") &&
        !type.startsWith("tool-approval")
      ) {
        names.push(type.slice("tool-".length));
      }
    }
  }
  return [...new Set(names)];
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
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
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
