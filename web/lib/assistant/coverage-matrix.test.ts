import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Whole-app route→tool coverage matrix (shard b04).
 *
 * Source-contract test: enumerates every `web/app/api/**\/route.ts` handler
 * directory and every `web/app/(app)/**\/page.tsx` page, and requires each to
 * resolve — by longest-prefix match over one shared table — to either the
 * tool(s) that reuse its service, or an explicit UNCOVERED entry with a
 * reason. Anything new without a mapping fails, listing the uncovered paths.
 *
 * Path space is normalised: the `api/` prefix (routes) and the leading `/`
 * (pages) are stripped, so `banking/reconciliations` covers both
 * `api/banking/reconciliations/[id]` and `/banking/reconciliations`.
 * An exact entry beats a prefix; the longest prefix wins.
 *
 * Reason vocabulary for UNCOVERED (enforced below):
 * - `no application service: ...` — writes whose route is inline SQL with no
 *   reusable application/domain service (per brief, these stay uncovered).
 * - `transport-only: ...` — auth/session/SOAP/webhook/machine endpoints,
 *   health/openapi/docs, external payer links: no user data view to cover.
 * - `assistant surface: ...` — the chat/commit/conversation surface itself.
 * - `static content: ...` — help/docs pages with no data service.
 * - `operator console: ...` — cross-organization operator pages, no tenant tool.
 * - `gap fill pending: ...` — a b04 gap-fill tool is planned; names the tool.
 */

type Entry = {
  prefix: string;
  /** Covering tool names (must exist in the catalogs). */
  tools?: string[];
  /** Why covered tools are only partial (writes without a service, etc.). */
  note?: string;
  /** Explicit gap: one of the vocabulary prefixes above. */
  uncovered?: string;
};

/**
 * The matrix. b04 gap-fill commits move entries from `uncovered: "gap fill
 * pending"` to `tools` and lower UNCOVERED_BUDGET accordingly.
 */
const MATRIX: Entry[] = [
  // --- landing / navigation -------------------------------------------------
  { prefix: "", tools: ["analytics_financial_health", "cash_position"] },
  { prefix: "dashboard", tools: ["analytics_financial_health", "cash_position", "ar_position", "ap_position", "inbox_items"], note: "persona tiles read the caller's own inbox items through the inbox adapters" },
  { prefix: "accounting", tools: ["trial_balance", "find_journal_entries"] },
  { prefix: "accounts", tools: ["find_accounts", "account_register"] },
  { prefix: "account-groups", tools: ["find_accounts"] },
  { prefix: "api-docs", uncovered: "transport-only: OpenAPI UI over v1/openapi, no data service" },
  { prefix: "docs", uncovered: "static content: help pages, no data service" },
  { prefix: "search", tools: ["find_accounts", "find_parties", "find_documents", "search_items", "rank_projects"], note: "global search fans out to the same domain finders the tools call" },
  { prefix: "query", uncovered: "no application service: ad-hoc query builder executes viewspec queries inline" },
  { prefix: "knowledge/views", uncovered: "no application service: saved view definitions have no record service" },
  { prefix: "views", uncovered: "no application service: saved view run/export is route-inline" },
  { prefix: "saved-reports", tools: ["list_report_definitions", "run_report"] },
  { prefix: "insights", uncovered: "no application service: dashboard/card builder persists inline" },
  // HR-15 gap fill: notifications stopped being route-inline SQL when the
  // inbox read model landed — every notice is an inbox item through the
  // shared adapters, and inbox_items reads them under the caller's scope.
  { prefix: "notifications", tools: ["inbox_items"], note: "notices read through the inbox read model; marking read is the reader's own act" },
  { prefix: "me", tools: ["whoami", "describe_page_layout"] },
  { prefix: "page-specs", tools: ["list_page_layouts", "describe_page_layout"] },
  { prefix: "settings/security", tools: ["list_users", "list_roles"] },
  // HR-15: the approvals place is the inbox; the route moved with it.
  { prefix: "inbox", tools: ["inbox_items", "list_approvals", "decide_approval"], note: "the unified inbox reads through the inbox adapters (same readers as the page) while decisions run through native Flows gates; step completion, submits, and acknowledgement are human-attested actions with no assistant write surface by design" },
  { prefix: "assistant", uncovered: "assistant surface: the chat/commit/conversation surface itself" },
  { prefix: "login", uncovered: "transport-only: session establishment, no data view" },
  { prefix: "access-denied", tools: ["whoami", "list_roles"], note: "permission-refusal explanation; no writes" },
  { prefix: "feature-required", tools: ["update_features"], note: "feature-gate explanation; enable path is Company Settings → Features" },
  { prefix: "auth", uncovered: "transport-only: credentials, MFA, OIDC, session cookies" },
  { prefix: "password-reset", uncovered: "transport-only: credential reset flow" },
  { prefix: "pay", uncovered: "transport-only: external payer link, no authenticated data view" },
  { prefix: "audit", tools: ["search_audit_log"] },
  // --- financial core -------------------------------------------------------
  { prefix: "journal", tools: ["find_journal_entries", "get_journal_entry", "post_journal", "draft_journal_entry"] },
  { prefix: "journals", tools: ["find_journal_entries", "get_journal_entry", "post_journal", "draft_journal_entry"] },
  { prefix: "documents", tools: ["find_documents", "get_document", "create_record", "update_record", "submit_document", "post_document", "void_document", "correct_document"] },
  { prefix: "records", tools: ["list_records", "get_record", "create_record", "update_record", "delete_record", "list_record_types"] },
  { prefix: "v1/records", tools: ["list_records", "get_record", "create_record", "update_record", "delete_record"], note: "external REST over the same record services" },
  { prefix: "v1/[typeKey]", tools: ["list_records", "get_record", "create_record", "update_record", "delete_record"], note: "first-class resource aliases of /v1/records/{typeKey}" },
  { prefix: "v1/reports", tools: ["list_report_definitions", "run_report"] },
  { prefix: "v1/payments", tools: ["create_payment", "update_payment", "post_payment", "list_records", "get_record"] },
  { prefix: "v1/setup", tools: ["list_setup_entities", "list_setup_records", "create_setup_record", "update_setup_record", "delete_setup_record"] },
  { prefix: "v1/layouts", tools: ["list_page_layouts", "describe_page_layout", "set_page_layout", "validate_page_layout", "preview_page_layout", "list_page_layout_history", "restore_page_layout", "clear_page_layout"] },
  { prefix: "v1/apps", tools: ["list_app_packages", "get_app_package", "draft_app", "get_app_draft", "describe_app_vocabulary", "activate_app_draft", "discard_app_draft"] },
  { prefix: "v1/settings", tools: ["get_company_settings", "update_company_settings", "update_features"] },
  { prefix: "v1/banking", tools: ["start_reconciliation", "match_bank_line", "match_bank_line_with_journal", "unmatch_bank_line", "sign_off_reconciliation", "list_bank_reconciliations"] },
  { prefix: "v1/budgets", tools: ["update_budget_cells"] },
  { prefix: "v1/files", tools: ["upload_file"] },
  { prefix: "v1/close", tools: ["list_close_runs", "get_close_run", "start_close_run", "request_period_reopen", "decide_period_reopen", "run_revaluation"] },
  { prefix: "v1/approvals", tools: ["list_approvals", "decide_approval"] },
  { prefix: "v1/commands", tools: ["list_record_types"], note: "RPC catalog over the application tools" },
  { prefix: "v1/documents", tools: ["submit_document", "post_document", "void_document", "correct_document"] },
  { prefix: "v1/journals", tools: ["post_journal", "draft_journal_entry", "get_journal_entry"] },
  { prefix: "v1/quotes", tools: ["search_orders", "get_order"] },
  { prefix: "v1/sales-orders", tools: ["search_orders", "get_order"] },
  { prefix: "v1/purchase-orders", tools: ["search_orders", "get_order"] },
  { prefix: "v1/field-tickets", tools: ["list_field_tickets", "get_field_ticket"] },
  { prefix: "v1/vitals", tools: ["get_vitals"] },
  { prefix: "v1", uncovered: "transport-only: health, openapi, and schema endpoints" },
  { prefix: "parties", tools: ["find_parties", "partner_statement"] },
  { prefix: "entities", tools: ["find_parties"] },
  { prefix: "customers", tools: ["find_parties", "partner_statement"] },
  { prefix: "ar", tools: ["ar_position", "aging", "aging_detail", "find_documents"] },
  { prefix: "ap", tools: ["ap_position", "aging", "aging_detail", "find_documents"] },
  { prefix: "collections", tools: ["ar_position", "aging"] },
  { prefix: "ap-capture", uncovered: "no application service: capture inbox and materialize are route-inline" },
  { prefix: "dunning", uncovered: "no application service: reminder policy ladder persists inline" },
  { prefix: "payments", tools: ["list_open_items", "aging", "create_payment", "update_payment", "post_payment"], note: "pay-run orchestration (runs/*) has no application service" },
  { prefix: "receipts", tools: ["ar_position", "list_open_items"], note: "direct-debit run orchestration has no application service" },
  { prefix: "banking", tools: ["list_bank_reconciliations", "get_bank_reconciliation", "list_unmatched_bank_lines", "list_bank_feeds", "start_reconciliation", "match_bank_line", "match_bank_line_with_journal", "unmatch_bank_line", "sign_off_reconciliation"], note: "sftp daemon ops have no application service" },
  { prefix: "psp", uncovered: "no application service: settlement parse/post persists inline" },
  { prefix: "qbd", uncovered: "transport-only: desktop-accounting SOAP transport endpoint" },
  // --- books, close, tax ----------------------------------------------------
  { prefix: "budgets", tools: ["list_budget_scenarios", "get_budget_scenario", "get_budget_workspace", "update_budget_cells"] },
  { prefix: "cash", tools: ["cash_position"] },
  { prefix: "close", tools: ["list_close_runs", "get_close_run", "get_close_run_status", "start_close_run", "list_period_locks", "list_period_reopen_requests", "request_period_reopen", "decide_period_reopen", "run_revaluation"] },
  { prefix: "admin/close", tools: ["list_period_locks", "list_period_reopen_requests"] },
  { prefix: "continuous-close", tools: ["continuous_close_findings", "get_continuous_close_finding", "list_close_runs", "get_close_run_status"] },
  { prefix: "agents", tools: ["continuous_close_findings", "get_continuous_close_finding"], note: "Agent Workbench inbox/item feed reuses the finding-tool queries" },
  { prefix: "tax", tools: ["list_tax_return_forms", "tax_return", "documents_missing_tax_code"], note: "provision/filing writes have no application service" },
  { prefix: "compliance", uncovered: "no application service: information returns, lien waivers, and compliance records persist inline" },
  { prefix: "consolidation", tools: ["get_consolidation_view"] },
  // --- operational modules --------------------------------------------------
  { prefix: "analytics", tools: ["analytics_financial_health", "analytics_customer_intelligence", "analytics_vendor_performance", "analytics_cashflow", "analytics_true_cost", "analytics_utilization", "analytics_spend_velocity", "analytics_sentinel", "ap_position", "ar_position", "cash_position"] },
  { prefix: "reports", tools: ["list_report_definitions", "run_report", "list_report_schedules", "list_reporting_packages", "list_report_runs", "list_email_deliveries", "general_ledger", "aging_detail", "cash_flow_indirect", "partner_statement"] },
  { prefix: "inventory", tools: ["search_items", "get_item", "inventory_levels", "inventory_movements", "inventory_writedowns"] },
  { prefix: "items", tools: ["search_items", "get_item"] },
  { prefix: "item-rate-books", tools: ["list_setup_entities", "list_setup_records", "get_item"], note: "rate books are a Setup-registry entity (the route resolves them through resolveSetupEntity), so the generic setup readers list the entity and its records; the rate an item resolves to reads through the item master" },
  { prefix: "sales-orders", tools: ["search_orders", "get_order"] },
  { prefix: "purchase-orders", tools: ["search_orders", "get_order"] },
  { prefix: "estimates", tools: ["search_orders", "get_order"], note: "estimate convert flow mirrors orders; convert writes have no application service" },
  { prefix: "purchasing", tools: ["search_orders", "get_order"] },
  { prefix: "assets", tools: ["search_assets", "get_asset", "asset_tax_pools"] },
  { prefix: "assets/leases", tools: ["search_lease_agreements", "get_lease_agreement"], note: "creation, change, commencement and post remain native approval-controlled actions; no assistant write tool" },
  { prefix: "leases", tools: ["search_lease_agreements", "get_lease_agreement"], note: "creation, change, commencement and post remain native approval-controlled actions; no assistant write tool" },
  { prefix: "equipment", tools: ["search_equipment", "get_equipment"] },
  { prefix: "projects", tools: ["rank_projects", "project_profitability"], note: "duplicates/merge/task maintenance writes have no application service" },
  { prefix: "billing-requests", tools: ["rank_projects", "project_profitability"], note: "billing-request lifecycle writes have no application service" },
  { prefix: "project-charges", uncovered: "no application service: charge capture persists inline" },
  { prefix: "project-schedule", uncovered: "no application service: schedule tasks persist inline" },
  { prefix: "work-schedules", uncovered: "no application service: schedule save persists inline" },
  { prefix: "construction", tools: ["retainage_balances", "get_subcontract"], note: "pay-application lifecycle writes have no application service" },
  { prefix: "subcontracts", tools: ["search_subcontracts", "get_subcontract", "list_wip_prebills", "get_wip_prebill", "wip_analytics"] },
  { prefix: "wip-billing", tools: ["search_subcontracts", "get_subcontract", "list_wip_prebills", "get_wip_prebill", "wip_analytics"] },
  { prefix: "crm", tools: ["search_opportunities", "get_opportunity", "search_crm_accounts", "get_crm_account", "search_crm_activities", "get_crm_activity", "crm_forecast"] },
  { prefix: "subscriptions", tools: ["list_subscription_plans", "list_subscriptions", "get_subscription", "subscription_mrr", "subscription_upcoming_invoices", "list_recurring_schedules"] },
  { prefix: "recurring", tools: ["list_recurring_schedules"] },
  { prefix: "property-management", tools: ["list_properties", "list_leases", "get_lease", "rent_roll", "lease_arrears", "property_deposits"] },
  { prefix: "timesheets", tools: ["get_timesheet_week", "search_timesheets", "project_time", "unbilled_time"], note: "approve/reject/reopen writes have no application service" },
  // HR-20: field clock status and crew batches read through the field-time services; clock/crew/post writes are human-attested with no assistant write surface by design.
  { prefix: "time", tools: ["time_clock_status", "crew_batches"], note: "own clock state plus today's pairs, the team clocked in, and crew batches with stage status reuse the field-time read services; clock events, kiosk identify, batch submit/approve/post are human-attested with no assistant write surface by design" },
  { prefix: "field-tickets", tools: ["list_field_tickets", "get_field_ticket"] },
  { prefix: "sign", uncovered: "no application service: signature capture persists inline" },
  { prefix: "expenses", tools: ["list_expense_reports", "get_expense_report", "expense_overview", "expense_approvals"] },
  { prefix: "payroll", tools: ["list_pay_runs", "get_pay_run", "payroll_year_end", "payroll_setup_status", "list_payroll_employees", "payroll_entitlements", "payroll_remittances"], note: "profiles/settings/opening-balance/retro/parallel-run writes have no application service" },
  { prefix: "hrm", tools: ["hrm_headcount", "hrm_employment_as_of", "hrm_change_requests", "hrm_positions_as_of", "hrm_processes", "hrm_leave", "hrm_recruiting", "hrm_performance_cycles", "hrm_turnover", "hrm_benefits", "hrm_me", "inbox_items", "hrm_compliance_findings", "hrm_certified_payroll", "hrm_compensation", "hrm_pay_equity", "hrm_qualifications", "hrm_dispatch_check", "hrm_one_on_ones", "hrm_feedback", "hrm_calibration", "hrm_documents", "hrm_survey_results", "hrm_org_chart", "hrm_explain_pay", "payroll_anomalies", "ai_draft", "nl_report"], note: "as-of headcount, the effective version with assignments, the change-request list, positions with vacancy, the process checklists, leave requests with balances, requisitions with the funnel, review cycles with progress, turnover, benefit elections, the caller's own employment summary, the held-qualification register, the dispatch readiness verdict, 1:1s read the caller's own and their reports' meetings with private items author-only, feedback reads through the visibility matrix, calibration reads the HR grid with the missing list, document register with signer progress, survey aggregates with suppression, the org chart, and the caller's own inbox items reuse their canonical HRM read services; explain-pay renders the deterministic payslip trace, anomaly flags and drafts come from deterministic services with ledger logging, and natural-language questions become validated report definitions; authoring stays human-attested with no tool" },
  // HR-21: the drafts route is served by the evidence-grounded drafting service behind the ai_draft tool.
  { prefix: "ai", tools: ["ai_draft"], note: "drafts render server-side from actor-readable sources with ledger logging; nothing auto-submits" },
  // HR-21 end.  // HR-13: findings and frozen runs read through the construction services (kept on one line: the scope test matches per-line).
  { prefix: "hrm", tools: ["hrm_headcount", "hrm_employment_as_of", "hrm_change_requests", "hrm_leave"], note: "as-of headcount, the effective version with assignments, the change-request list, and the leave-request list with TIME balances reuse the employment and leave read services; authoring stays human-attested with no tool" },
  { prefix: "labor-rate-cards", uncovered: "no application service: rate card writes are route-inline" },
  { prefix: "rate-book-assignments", tools: ["list_setup_records"], note: "item-rate-book-assignments is a setup entity" },
  { prefix: "revenue", uncovered: "no application service: recognition run persists inline" },
  // --- files, data, sync, environments, pdf, email ---------------------------
  { prefix: "file-cabinet", tools: ["list_files", "get_file", "list_folders", "upload_file"], note: "grant admin writes have no application service" },
  { prefix: "data", tools: ["list_data_resources", "list_import_runs"] },
  { prefix: "sync", tools: ["list_sync_connections"] },
  { prefix: "platform/connections", tools: ["list_sync_connections"] },
  { prefix: "platform", uncovered: "operator console: cross-organization pages, no tenant tool" },
  { prefix: "admin/sandboxes", tools: ["list_environments"] },
  { prefix: "pdf-templates", tools: ["list_pdf_templates", "get_pdf_template"] },
  { prefix: "record-pdf", tools: ["get_pdf_template", "get_document"], note: "binary render itself has no tool; design and source record read via templates and documents" },
  { prefix: "admin/email", tools: ["get_outbox_status"], note: "provider config writes have no application service; delivery reads via the outboxes" },
  // --- setup, apps, platform ------------------------------------------------
  { prefix: "admin/users", tools: ["list_users"], note: "assign/unassign/set-active writes have no application service" },
  { prefix: "admin/roles", tools: ["list_roles"], note: "role writes have no application service" },
  { prefix: "admin/api-keys", tools: ["list_api_keys"], note: "key mint/suspend/revoke writes have no application service" },
  { prefix: "admin/audit", tools: ["search_audit_log", "get_outbox_status"] },
  { prefix: "admin/settings", tools: ["get_company_settings", "update_company_settings"] },
  { prefix: "admin/setup", tools: ["list_setup_entities", "list_setup_records", "create_setup_record", "update_setup_record", "delete_setup_record", "update_features"] },
  { prefix: "admin/custom-fields", tools: ["list_record_types"], note: "field-definition writes have no application service" },
  { prefix: "admin/customization", tools: ["list_page_layouts", "describe_page_layout"] },
  { prefix: "admin/page-layouts", tools: ["list_page_layouts", "describe_page_layout", "list_page_layout_history"] },
  { prefix: "admin/pdf-templates", tools: ["list_pdf_templates", "get_pdf_template"] },
  { prefix: "customization", tools: ["list_page_layouts", "describe_page_layout"] },
  { prefix: "admin/flows", tools: ["list_approvals"], note: "flow authoring writes have no application service" },
  // HR-16 begin: the automation recipe list/builder reads through the automations read service; recipe authoring, enable/disable, run-now and simulate are human-attested with no assistant write surface by design.
  { prefix: "admin/automations", tools: ["automations_status"], note: "the recipe list, builder, simulate and runs read through the automations read service; authoring, enable/disable, run-now and simulate are human-attested with no assistant write surface by design" },
  { prefix: "automations", tools: ["automations_status"], note: "recipe and run reads reuse the automations read service; writes are human-attested with no assistant write surface by design" },
  // HR-16 end
  { prefix: "flows", tools: ["list_approvals", "decide_approval"], note: "flow authoring and manual/record-state triggers have no application service" },
  { prefix: "hrm/change-requests", tools: ["hrm_change_requests", "list_approvals", "decide_approval"], note: "the queue lists through the employment read service while decisions run through native Flows gates; authoring, submit and withdraw are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/leave", tools: ["hrm_leave", "list_approvals", "decide_approval"], note: "the queue, department calendar, and drawer read through the leave read service while decisions run through native Flows gates; filing, submit, withdraw, cancel and absence recording are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/my-leave", tools: ["hrm_leave"], note: "the self-service inbox reads only the caller's own requests and balances; filing is a human-attested HR action with no assistant write surface by design" },
  { prefix: "hrm/leave-requests", tools: ["hrm_leave", "list_approvals", "decide_approval"], note: "the queue and drawer read through the leave read service (TIME balances; VALUE stays in payroll tools) while decisions run through native Flows gates; filing, submit, withdraw, cancel and attachment are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/leave-absences", tools: ["hrm_leave"], note: "after-the-fact absence recording is a human-attested HR action with no assistant write surface by design" },
  // HR-18: the public career-site surface. Like the external payer link,
  // these are token-addressed endpoints used by someone who is not a user
  // of this system — a candidate applying, choosing an interview slot, or
  // signing their own offer, plus the signed feed boards read. No tenant
  // data view exists for a tool to cover, and no assistant may act in the
  // candidate's place.
  { prefix: "recruiting", uncovered: "transport-only: public career-site apply, tokened self-booking and offer signature, and the signed board feed" },
  { prefix: "hrm/recruiting", tools: ["hrm_recruiting"], note: "the requisitions list and the requisition, candidate, and offer drawers read through the recruiting read service (names only, contact PII never leaves); requisition authoring, funnel moves, interviews, offers, and hire are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/performance", tools: ["hrm_performance_cycles"], note: "the cycles list and drawer read through the privacy-scoped performance read service; submit, calibrate, share, acknowledge and goal writes are human-attested HR actions with no assistant write surface by design" },
  // HR-17 begin: continuous performance reads ride the structural scope
  // (1:1s, feedback) and the manage grant (calibration); scheduling,
  // rating decisions, talent records and succession writes are
  // human-attested HR actions with no assistant write surface by design.
  { prefix: "hrm/one-on-ones", tools: ["hrm_one_on_ones"], note: "1:1s read the caller's own and their reports' meetings with private items author-only; scheduling, agenda writes and carry-forward are human-attested with no assistant write surface by design" },
  { prefix: "hrm/feedback", tools: ["hrm_feedback"], note: "feedback reads through the visibility matrix; giving, fulfilling and retracting are human-attested with no assistant write surface by design" },
  { prefix: "hrm/calibration-sessions", tools: ["hrm_calibration"], note: "calibration reads the HR grid with the missing list; opening, deciding, reverting and closing are human-attested with no assistant write surface by design" },
  { prefix: "hrm/calibration-entries", tools: ["hrm_calibration"], note: "entry reads go through the session grid; deciding an entry is a human-attested HR action with no assistant write surface by design" },
  // HR-17 end
  { prefix: "hrm/benefits", tools: ["hrm_benefits"], note: "windows, elections, and monthly inputs read through the benefits read service; electing, approving, and input generation are human-attested HR actions with no assistant write surface by design" },
  // HR-13 begin: the Compliance tab reads flags and frozen runs through
  // the construction services; generating, approving, and finding
  // transitions are human-attested HR actions with no write surface.
  { prefix: "hrm/compliance", tools: ["hrm_compliance_findings", "hrm_certified_payroll"], note: "findings and frozen certified runs read through the construction services; generation, approval, voids, submit, amend, acknowledge and resolve are human-attested HR actions with no assistant write surface by design" },
  // HR-14: the register and the readiness check read through the qualification services; recording, verifying, renewing, revoking, and requirement authoring are human-attested HR actions with no assistant write surface by design.
  { prefix: "hrm/qualifications", tools: ["hrm_qualifications", "hrm_dispatch_check"], note: "the held-qualification register and the per-assignment readiness verdict read through the qualification services; recording, verifying, renewing, revoking, and requirement authoring are human-attested with no assistant write surface by design" },
  // HR-19: the document register, survey aggregates, and org tree read
  // through the documents/surveys/org-chart services; issuing, sending,
  // signing, voiding, holds, retention execution, exports, authoring,
  // opening, closing, and responding are human-attested HR actions with
  // no assistant write surface by design.
  { prefix: "hrm/documents", tools: ["hrm_documents"], note: "the document register with signer progress reads through the documents read service; issuing, generating, uploading, sending, reminding, signing, declining, acknowledging, voiding, holds, retention execution, and exports are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/surveys", tools: ["hrm_survey_results"], note: "survey aggregates read through the survey results service with minimum-group suppression; authoring, opening, inviting, closing, and responding are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/org-chart", tools: ["hrm_org_chart"], note: "the tree and directory read through the org-chart service as of a date; establishment changes are human-attested HR actions with no assistant write surface by design" },
  { prefix: "me/documents", tools: ["hrm_documents"], note: "own documents and exports read through the own-scope document services; signing and acknowledging are human-attested actions with no assistant write surface by design" },
  { prefix: "me/surveys", tools: ["hrm_survey_results"], note: "open invitations read through the own-scope survey service; responding is a human-attested action with no assistant write surface by design" },
  { prefix: "surveys", tools: ["hrm_survey_results"], note: "invitation reissue and response capture persist inline on the public route; aggregates read through the survey results service" },
  // HR-13 end
  { prefix: "hrm/enrollment-windows", tools: ["hrm_benefits"], note: "window open and close are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/enrollments", tools: ["hrm_benefits"], note: "electing, approving, changing, ending, and dependent linking are human-attested HR actions with no assistant write surface by design" },
  { prefix: "hrm/dependents", tools: ["hrm_benefits"], note: "dependent authoring is a human-attested HR action with no assistant write surface by design" },
  { prefix: "hrm/retention", tools: ["hrm_turnover"], note: "the retention overview and turnover table read through the retention read service; exit recording is a human-attested HR action with no assistant write surface by design" },
  { prefix: "me", tools: ["hrm_me"], note: "the Me workspace reads only the caller's own employment summary, review cycles, and benefits through the self-service read services; profile filing, step completion, review answers, and elections are human-attested actions with no assistant write surface by design" },
  { prefix: "admin/fx-provider", tools: ["list_currencies", "list_fx_rates"] },
  { prefix: "admin/navigation", uncovered: "no application service: nav config persists inline" },
  { prefix: "admin/payment-operations", uncovered: "no application service: bank-profile/format/schedule config persists inline" },
  { prefix: "admin/backups", uncovered: "no application service: backup policy/run/download is route-inline" },
  { prefix: "admin/ai", uncovered: "no application service: model and document-capture config persists inline" },
  { prefix: "admin/scripts", uncovered: "no application service: script definitions persist inline" },
  { prefix: "scripts", uncovered: "transport-only: extension script delivery endpoints" },
  { prefix: "admin/apps", tools: ["list_app_packages", "get_app_package"] },
  { prefix: "admin/build", tools: ["draft_app", "get_app_draft"] },
  { prefix: "apps", tools: ["list_app_packages", "get_app_package", "draft_app", "get_app_draft", "describe_app_vocabulary", "activate_app_draft", "discard_app_draft"] },
  { prefix: "allocations", tools: ["list_allocation_rules", "get_allocation_rule", "list_allocation_drivers", "preview_driver_vector", "preview_allocation", "list_allocation_runs", "explain_allocation", "run_report", "list_report_definitions"], note: "run_report covers the Allocation summary / lineage built-in reports; the allocation_* tools reuse the same engine services as the setup routes" },
  { prefix: "admin", tools: ["list_users", "get_company_settings"] },
  { prefix: "admin/super", uncovered: "operator console: cross-organization page, no tenant tool" },
  { prefix: "forms", uncovered: "no application service: form template publish persists inline" },
  { prefix: "internal/reports/render", tools: ["run_report"], note: "same execution basis as run_report" },
  { prefix: "internal", uncovered: "no application service: internal publish endpoints" },
  { prefix: "feedback", uncovered: "assistant surface: the in-app issue reporter's own triage turn" },
];

/**
 * The allowlist must only shrink: lower this as gap-fill commits land.
 *
 * 34 → 35 on 2026-09-17 for `feedback`, and that is NOT a gap-fill
 * regression: the in-app issue reporter is a second, deliberately scoped
 * assistant surface (@braedonsaunders/appkit-feedback), covered by exactly
 * the same reasoning as the `assistant` entry beside it. A tool that files
 * product issues on the reporter's behalf is not a gap to fill — the
 * reporter's whole design is that a PERSON describes the defect.
 */
const UNCOVERED_BUDGET = 35;

const REASON_VOCABULARY = [
  "no application service:",
  "transport-only:",
  "assistant surface:",
  "static content:",
  "operator console:",
  "gap fill pending:",
] as const;

const here = import.meta.dirname;
const repoRoot = join(here, "..", "..", "..");
const apiDir = join(repoRoot, "web", "app", "api");
const appDir = join(repoRoot, "web", "app", "(app)");

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** Longest-prefix match on `/`-boundaries; exact entries win naturally. */
function matchEntry(key: string): Entry | null {
  let best: Entry | null = null;
  for (const entry of MATRIX) {
    if (key === entry.prefix || (entry.prefix !== "" && key.startsWith(`${entry.prefix}/`))) {
      if (!best || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  return best;
}

function routeKeys(): string[] {
  return walkFiles(apiDir)
    .filter((f) => f.endsWith("/route.ts"))
    .map((f) => f.slice(apiDir.length + 1, -"/route.ts".length).replace(/\\/g, "/"));
}

function pageKeys(): string[] {
  return walkFiles(appDir)
    .filter((f) => f.endsWith("/page.tsx"))
    .map((f) => {
      const rel = f.slice(appDir.length + 1, -"/page.tsx".length).replace(/\\/g, "/");
      return rel === "page" ? "" : rel.replace(/\/page$/, "");
    });
}

function toolNamesFrom(...relativePaths: string[]): Set<string> {
  const names = new Set<string>();
  for (const relativePath of relativePaths) {
    const source = readFileSync(join(here, relativePath), "utf8");
    for (const match of source.matchAll(/name: ["'`]?\$?\{?["'`]?([a-z0-9_]+)["'`]/g)) {
      if (match[1]) names.add(match[1]);
    }
    for (const match of source.matchAll(/`\$\{action\}_document`/g)) {
      void match;
      names.add("submit_document");
      names.add("post_document");
    }
    for (const match of source.matchAll(/(\w+): \[["']([a-z0-9_]+)["'],/g)) {
      if (match[2]) names.add(match[2]);
    }
  }
  return names;
}

/** Every tool source the matrix may reference (same scrape as skills.test.ts). */
const TOOL_FILES = [
  "../application/tool-catalog.ts",
  "./tools.ts",
  "./tools-write.ts",
  "./tools-analytics.ts",
  "./tools-reports.ts",
  "./tools-banking.ts",
  "./tools-close.ts",
  "./tools-fx.ts",
  "./tools-budgets.ts",
  "./tools-admin.ts",
  "./tools-payroll.ts",
  "./tools-hrm.ts",
  "./tools-files.ts",
  "./tools-ops.ts",
  "./tools-inventory.ts",
  "./tools-orders.ts",
  "./tools-assets.ts",
  "./tools-equipment.ts",
  "./tools-subcontracts.ts",
  "./tools-setup.ts",
  "./tools-projects.ts",
  "./tools-tax.ts",
  "./tools-construction.ts",
  "./tools-meta.ts",
  "../apps/tools.ts",
  "./tools-crm.ts",
  "./tools-subscriptions.ts",
  "./tools-allocations.ts",
  "./tools-property.ts",
  "./tools-time.ts",
  "./tools-expenses.ts",
];

test("every api route maps to covering tools or an explicit uncovered reason", () => {
  const missing: string[] = [];
  const uncovered: { key: string; reason: string }[] = [];
  for (const key of routeKeys()) {
    const norm = key.startsWith("api/") ? key.slice("api/".length) : key;
    const entry = matchEntry(norm);
    if (!entry) {
      missing.push(`api/${norm}`);
      continue;
    }
    if (entry.uncovered) uncovered.push({ key: `api/${norm}`, reason: entry.uncovered });
  }
  assert.deepEqual(missing, [], `api routes with no matrix entry:\n${missing.join("\n")}`);
});

test("every app page maps to covering tools or an explicit uncovered reason", () => {
  const missing: string[] = [];
  for (const key of pageKeys()) {
    const entry = matchEntry(key);
    if (!entry) missing.push(key === "" ? "/" : `/${key}`);
  }
  assert.deepEqual(missing, [], `app pages with no matrix entry:\n${missing.join("\n")}`);
});

test("every covering tool names a real registered tool", () => {
  const names = toolNamesFrom(...TOOL_FILES);
  assert.ok(names.size >= 20, `catalog extraction looks broken (${names.size} names)`);
  const unknown: string[] = [];
  for (const entry of MATRIX) {
    for (const tool of entry.tools ?? []) {
      if (!names.has(tool)) unknown.push(`${entry.prefix || "/"} → ${tool}`);
    }
  }
  assert.deepEqual(unknown, [], `matrix references unknown tools:\n${unknown.join("\n")}`);
});

test("uncovered reasons use the vocabulary and the allowlist only shrinks", () => {
  const bad: string[] = [];
  let count = 0;
  for (const entry of MATRIX) {
    if (!entry.uncovered) continue;
    count += 1;
    if (!REASON_VOCABULARY.some((v) => entry.uncovered!.startsWith(v))) {
      bad.push(`${entry.prefix || "/"}: ${entry.uncovered}`);
    }
  }
  assert.deepEqual(bad, [], `uncovered entries outside the reason vocabulary:\n${bad.join("\n")}`);
  assert.ok(
    count <= UNCOVERED_BUDGET,
    `uncovered allowlist has ${count} entries (budget ${UNCOVERED_BUDGET}); gap-fill commits must lower the budget, never raise it`,
  );
});

test("every matrix prefix matches at least one route or page", () => {
  const routes = routeKeys().map((k) => (k.startsWith("api/") ? k.slice("api/".length) : k));
  const pages = pageKeys();
  const all = [...routes, ...pages];
  const unused = MATRIX.filter(
    ({ prefix }) => !all.some((k) => k === prefix || (prefix !== "" && k.startsWith(`${prefix}/`))),
  ).map(({ prefix }) => prefix || "/");
  assert.deepEqual(unused, [], `matrix prefixes matching nothing (stale):\n${unused.join("\n")}`);
});

test("the matrix scrapes every assistant tool file", () => {
  const onDisk = readdirSync(here)
    .filter((f) => f.startsWith("tools-") && f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "tools-shared.ts")
    .map((f) => `./${f}`)
    .sort();
  const scraped = TOOL_FILES.filter((f) => f.startsWith("./tools-")).sort();
  assert.deepEqual(scraped, onDisk, "a tool file is not scraped: add it to TOOL_FILES (and skills.test.ts)");
});
