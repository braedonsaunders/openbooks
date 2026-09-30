import { createHash } from "node:crypto";
import { mul } from "../money/money.ts";
import { sampleCompanyFeatures } from "./features.ts";

export interface DemoContext {
  orgId: string; industryKey: string; companyName: string; actorId: string;
  subsidiaryId: string; bookId: string; periodId: string; customerId: string; vendorId: string;
  employeeId: string; currency: string; date: string; year: number;
  accounts: { bank: string; receivable: string; revenue: string; expense: string; inventory: string; payable: string; equipment: string; accumulatedDepreciation: string; deferredRevenue: string };
  opportunityStatusId: string;
}
export interface DemoRecord {
  table: string; key: string; values: Record<string, string | number | boolean | null | object>;
  primaryKey?: string;
}
/** Stable tenant-local identities make interrupted installations safe to retry. */
export function demoRecordId(orgId: string, table: string, key: string): string {
  const bytes = createHash("sha256").update(`openbooks-demo-v2:${orgId}:${table}:${key}`).digest();
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Native editable records supplement the simulator's posted accounting history.
 * Financial workflows start as drafts; their normal services perform approvals
 * and posting when an operator explores them. External connections are inert.
 */
export function demoRecords(c: DemoContext): DemoRecord[] {
  const rows: DemoRecord[] = [];
  const features = sampleCompanyFeatures(c.industryKey);
  const id = (table: string, key = "main") => demoRecordId(c.orgId, table, key);
  const add = (table: string, values: DemoRecord["values"], key = "main", primaryKey = "id") => {
    const recordId = typeof values[primaryKey] === "string" ? values[primaryKey] : id(table, key);
    rows.push({ table, key, primaryKey, values: { [primaryKey]: recordId, org_id: c.orgId, created_by: c.actorId, updated_by: c.actorId, ...values } });
    return String(recordId);
  };
  add("accounts", { number: "3998", name: "Demonstration contributed capital", type: "equity", is_active: true }, "capital");
  if (features.fixedAssets) {
    add("accounts", { number: "1598", name: "Demonstration operating equipment", type: "asset_fixed", is_active: true }, "equipment");
    add("accounts", { number: "1698", name: "Demonstration accumulated depreciation", type: "asset_fixed", is_active: true }, "accumulated-depreciation");
  }
  const demonstrationBank = add("accounts", { number: "1098", name: "Demonstration operating cash", type: "asset_bank", is_active: true }, "bank");
  const demonstrationDeferred = features.revenueRecognition ? add("accounts", { number: "2398", name: "Demonstration deferred service revenue", type: "liability_current_other", is_active: true }, "deferred-revenue") : "";
  c = { ...c, employeeId: id("parties", "employee"), accounts: { ...c.accounts, bank: demonstrationBank, deferredRevenue: demonstrationDeferred } };
  add("parties", { kind: "person", display_name: "Jordan Lee", is_active: true }, "employee");
  add("employee_roles", { party_id: c.employeeId, employee_number: "DEMO-EMP-001", job_title: "Operations specialist", hired_on: `${c.year}-01-01` });
  const date = c.date;
  const end = `${c.year}-12-31`;
  const sunday = (value: string) => { const day = new Date(`${value}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - day.getUTCDay()); return day.toISOString().slice(0, 10); };
  const department = add("departments", { name: "Operations", code: "DEMO-OPS", subsidiary_id: c.subsidiaryId });
  const location = add("locations", { name: "Main operating location", code: "DEMO-MAIN", subsidiary_id: c.subsidiaryId });
  const serviceItem = add("items", { code: "DEMO-SERVICE", name: "Professional services", kind: "service", unit: "hour", income_account_id: c.accounts.revenue, expense_account_id: c.accounts.expense, default_rate: "175.00", show_on_timesheet: true });
  const expense = add("documents", { kind: "expense_report", document_number: "DEMO-EXP-001", party_id: c.employeeId, document_date: date, currency: c.currency, subsidiary_id: c.subsidiaryId, subtotal: "185.00", total: "185.00", memo: "Client-site travel reimbursement" }, "expense");
  add("document_lines", { document_id: expense, line_number: 1, account_id: c.accounts.expense, description: "Travel and parking", quantity: "1.00", unit_price: "185.00", amount: "185.00", subsidiary_id: c.subsidiaryId }, "expense");
  const scenario = add("budget_scenarios", { book_id: c.bookId, fiscal_year: c.year, name: `${c.year} operating plan`, description: "Synthetic operating plan for comparing actual activity with budget." });
  add("budget_lines", { scenario_id: scenario, account_id: c.accounts.revenue, period_id: c.periodId, subsidiary_id: c.subsidiaryId, amount: "125000.00", note: "Monthly sales target" });
  add("budget_lines", { scenario_id: scenario, account_id: c.accounts.expense, period_id: c.periodId, subsidiary_id: c.subsidiaryId, amount: "-42000.00", note: "Monthly operating cost envelope" }, "expense");
  add("bank_statements", { account_id: c.accounts.bank, source: "csv", statement_date: date, opening_balance: "100000.00", closing_balance: "99500.00", raw_file_ref: "synthetic-demo-statement" }, "operating-v3");
  add("bank_statement_lines", { statement_id: id("bank_statements", "operating-v3"), account_id: c.accounts.bank, line_number: 1, posted_on: date, amount: "-500.00", currency: c.currency, description: "Monthly account service and merchant charges", bank_transaction_id: `demo-${c.orgId}-operating-bank-fee` }, "operating-v3");
  add("reconciliations", { account_id: c.accounts.bank, through_date: date, statement_balance: "99500.00", currency: c.currency }, "operating-v3");
  add("close_blueprints", { name: "Monthly finance review", description: "Bank reconciliation, receivables review, accruals, and independent signoff." });
  add("close_blueprint_steps", { blueprint_id: id("close_blueprints"), key: "bank-reconciliation", title: "Reconcile operating bank", workstream: "cash", task_type: "action", completion_mode: "manual", sort_order: 10 });
  if (features.crm) {
    for (const [index, title] of ["Annual supply agreement", "Regional expansion", "Renewal and service extension"].entries()) {
      add("crm_opportunities", { opportunity_number: `DEMO-OPP-${index + 1}`, title, party_id: c.customerId, owner_user_id: c.actorId, status_id: c.opportunityStatusId, currency: c.currency, projected_amount: ["48000.00", "125000.00", "72000.00"][index]!, weighted_amount: "0.00", probability: 0, expected_close_date: end, next_step: "Review scope with the customer", subsidiary_id: c.subsidiaryId }, String(index));
    }
  }
  if (features.revenueRecognition) add("recognition_rules", { code: "DEMO-RATABLE", name: "Ratable service revenue — twelve months", method: "straight_line_even", recognition_periods: 12, deferred_account_id: c.accounts.deferredRevenue, recognized_account_id: c.accounts.revenue });
  if (features.fixedAssets) {
    const category = add("asset_categories", { name: "Operating equipment", asset_account_id: c.accounts.equipment, accumulated_depreciation_account_id: c.accounts.accumulatedDepreciation, depreciation_expense_account_id: c.accounts.expense, default_life_months: 60 });
    add("fixed_assets", { category_id: category, asset_number: "DEMO-FA-001", name: c.industryKey === "healthcare_practice" ? "Diagnostic ultrasound system" : "Operations equipment upgrade", subsidiary_id: c.subsidiaryId, acquired_on: date, acquisition_cost: "45000.00", salvage_value: "5000.00", description: "Draft acquisition awaiting capitalization through the asset workflow." });
  }
  if (features.equipment) add("equipment_units", { subsidiary_id: c.subsidiaryId, unit_number: "DEMO-EQ-001", name: "Mobile service unit", purchase_price: "32000.00", acquired_on: date });
  if (features.bankFeeds) add("bank_feed_connections", { name: "Demo bank feed configuration", provider: "manual", account_id: c.accounts.bank, status: "disconnected", is_active: false, sync_cadence: "manual" });
  if (features.onlinePayments) add("psp_provider_configs", { provider: "stripe", display_name: "Demo card acceptance — credentials required", is_enabled: false, acceptance_enabled: false, default_bank_account_id: c.accounts.bank, default_fee_account_id: c.accounts.expense });
  if (features.multiSubsidiary) add("subsidiaries", { parent_id: c.subsidiaryId, name: `${c.companyName} — Regional Operations`, base_currency: c.currency, country: "US" });
  if (features.multiCurrency) add("fx_rates", { from_currency: c.currency === "USD" ? "EUR" : "USD", to_currency: c.currency, as_of: date, rate: c.currency === "USD" ? "1.0800000000" : "1.3500000000", source: "manual" });

  const project = features.projects ? add("projects", { code: "DEMO-PROJECT", name: c.industryKey === "construction_contractor" ? "Riverfront Community Centre" : "Client delivery programme", customer_id: c.customerId, subsidiary_id: c.subsidiaryId, starts_on: date, ends_on: end, notes: "Synthetic project for exploring planning, time, and billing." }) : null;
  if (project && features.timeTracking) {
    const timeType = add("time_types", { name: "Regular professional time", cost_multiplier: "1.00" });
    add("time_entries", { employee_party_id: c.employeeId, worked_on: date, hours: "7.50", project_id: project, department_id: department, item_id: serviceItem, time_type_id: timeType, memo: "Site review and delivery planning", is_billable: true, cost_rate: "65.00", bill_rate: "175.00" });
  }
  if (project && features.projectScheduling) {
    add("schedule_calendars", { project_id: project, name: "Project weekday calendar", description: "Monday–Friday, 08:00–17:00" });
    add("project_tasks", { project_id: project, code: "DEMO-DESIGN", name: "Design and approvals", schedule_order: 10, schedule_start: date, schedule_duration: 10, schedule_calendar_id: id("schedule_calendars") });
    add("project_tasks", { project_id: project, code: "DEMO-DELIVER", name: "Delivery and handover", schedule_order: 20, schedule_start: date, schedule_duration: 20, schedule_calendar_id: id("schedule_calendars") }, "delivery");
  }
  if (project && features.subcontracts) {
    const subcontract = add("subcontracts", { project_id: project, vendor_id: c.vendorId, number: "DEMO-SC-001", title: "Specialist installation package", currency: c.currency, original_commitment: "85000.00", default_retainage_percent: "10.00", starts_on: date, ends_on: end });
    add("subcontract_sov_lines", { subcontract_id: subcontract, item_no: "01", description: "Specialist installation and commissioning", scheduled_value: "85000.00", retainage_percent: "10.00", expense_account_id: c.accounts.expense });
  }
  if (project && features.wipBilling) add("wip_prebills", { project_id: project, worksheet_number: "DEMO-WIP-001", period_start: date, period_end: end, notes: "Draft commercial review; add eligible work before approval." });
  if (project && features.resourcing) {
    add("res_demand_lines", { department_id: department, job_title: "Senior consultant", first_week: sunday(date), last_week: sunday(end), hours_per_week: "24.00", note: "Delivery capacity for the client programme" });
    if (features.resourceRequests) add("res_requests", { project_id: project, employee_party_id: c.employeeId, first_week: sunday(date), last_week: sunday(end), hours_per_week: "24.00", bill_item_id: serviceItem, reason: "Approve staffing for client delivery" });
    if (features.retainerBilling) add("res_retainers", { project_id: project, customer_party_id: c.customerId, kind: "hours", total_amount: "28000.00", total_hours: "160.00", unit_rate: "175.00", starts_on: date, ends_on: end, retainer_item_id: serviceItem, currency: c.currency });
  }
  if (features.fieldTickets && project) {
    const ticket = add("documents", { kind: "field_ticket", document_number: "DEMO-FT-001", document_date: date, currency: c.currency, subsidiary_id: c.subsidiaryId, project_id: project, memo: "Draft site labour and equipment capture" }, "field-ticket");
    add("field_tickets", { document_id: ticket, period: "daily", period_start: date, period_end: date, foreman_party_id: c.employeeId }, "main", "document_id");
  }
  if (features.fieldTime) add("time_kiosks", { name: "Site office clock — inactive demo", project_id: project, location_id: location, device_token_hash: createHash("sha256").update(`demo-kiosk-${c.orgId}`).digest("hex"), is_active: false });
  if (features.subcontractorCompliance) {
    const requirement = add("compliance_requirements", { code: "DEMO-LIABILITY", name: "Commercial general liability", category: "insurance", min_coverage_amount: "2000000.00", coverage_currency: c.currency });
    add("compliance_records", { party_id: c.vendorId, requirement_id: requirement, project_id: project, effective_from: date, expires_on: end, coverage_amount: "2000000.00", coverage_currency: c.currency, issuer_name: "Synthetic Insurance Company", policy_number: "DEMO-CGL-001", notes: "Synthetic certificate awaiting verification." });
  }

  if (features.hrm || features.payroll) {
    const employment = add("worker_employments", { worker_party_id: c.employeeId, employer_subsidiary_id: c.subsidiaryId, employment_number: "DEMO-EMP-001", service_start: `${c.year}-01-01`, service_start_provenance: "documented" });
    add("worker_employment_versions", { employment_id: employment, version_no: 1, status: "active", effective_from: `${c.year}-01-01` });
    if (features.hrmCompensation) {
      const family = add("hrm_job_families", { code: "DEMO-DELIVERY", name: "Client delivery" });
      const level = add("hrm_job_levels", { family_id: family, code: "DEMO-SENIOR", name: "Senior professional", rank: 3 });
      add("hrm_pay_bands", { family_id: family, level_id: level, employer_subsidiary_id: c.subsidiaryId, currency: c.currency, basis: "annual", min: "85000.00", target: "105000.00", max: "125000.00", effective_from: `${c.year}-01-01` });
    }
    if (features.hrmPerformance) {
      const template = add("hrm_review_templates", { name: "Professional development review" });
      const section = add("hrm_review_template_sections", { template_id: template, position: 1, title: "Delivery quality", kind: "free_text", weight: "100.00" });
      add("hrm_review_template_questions", { section_id: section, position: 1, prompt: "How consistently does the employee deliver accurate work?", answer_kind: "rating" });
      add("hrm_review_cycles", { template_id: template, name: `${c.year} development review`, period_start_on: `${c.year}-01-01`, period_end_on: end });
      add("hrm_goals", { employment_id: employment, title: "Improve client delivery quality", description: "Complete peer review and document outcomes for three engagements.", due_on: end, progress_percent: 25 });
    }
    if (features.hrmDocuments) {
      add("hrm_document_categories", { key: "demo-handbook", label: "Employee handbook" });
      add("hrm_document_templates", { name: "Handbook acknowledgment", category_key: "demo-handbook", body_template: "I acknowledge receipt of the company handbook and know how to request clarification.", acknowledgment_only: true });
    }
    if (features.hrmCertifications) {
      const qualification = add("hrm_qualification_types", { code: "DEMO-FIRST-AID", name: "Workplace first aid", category: "training", issuing_body: "Synthetic training provider", validity_months: 24 });
      add("hrm_worker_qualifications", { employment_id: employment, type_id: qualification, identifier: "DEMO-QUAL-001", issued_on: date, expires_on: `${c.year + 2}-12-31`, notes: "Synthetic qualification awaiting evidence verification." });
    }
    if (features.hrmSurveys) {
      const survey = add("hrm_surveys", { name: "Quarterly engagement pulse", kind: "pulse", anonymity: "anonymous", min_group_size: 5 });
      add("hrm_survey_questions", { survey_id: survey, position: 1, kind: "scale", prompt: "I have the resources I need to deliver quality work." });
    }
    if (features.hrmRecruiting) add("hrm_requisitions", { requisition_number: "DEMO-REQ-001", title: "Senior client delivery professional", employer_subsidiary_id: c.subsidiaryId, department_id: department, headcount: 2, compensation_min: "85000.00", compensation_max: "125000.00", compensation_currency: c.currency, compensation_basis: "annual", description: "Draft hiring request for the growing client portfolio." });
    if (features.hrmConstructionCompliance) {
      const classification = add("hrm_work_classifications", { code: "DEMO-IRONWORKER", name: "Journeyperson ironworker", trade: "Ironworking" });
      const rate = add("hrm_rate_schedules", { kind: "org_declared", name: "Demo site wage agreement", reciprocity: "jobsite_local", effective_from: date, source_ref: "Synthetic training agreement; not a statutory rate table" });
      add("hrm_rate_schedule_lines", { schedule_id: rate, classification_id: classification, base_rate: "42.00", fringe_rate: "12.00", overtime_multiplier: "1.50", currency: c.currency, effective_from: date });
    }
    if (features.payroll) {
      const schedule = add("pay_schedules", { name: "Demo biweekly payroll", frequency: "biweekly", periods_per_year: 26, anchor_period_end: date, pay_date_offset_days: 3, subsidiary_id: c.subsidiaryId });
      add("employee_payroll_profiles", { employee_party_id: c.employeeId, employment_id: employment, pay_schedule_id: schedule, province: "CA", country: "US", pay_basis: "hourly", filing_status: "single", residence_region: "CA", labour_jurisdiction: "US-CA", stub_delivery: "print" });
      const run = add("documents", { kind: "pay_run", document_number: "DEMO-PAY-001", document_date: date, currency: c.currency, subsidiary_id: c.subsidiaryId, memo: "Draft payroll; configure employer registrations and statutory inputs before calculation." }, "payroll");
      add("pay_runs", { document_id: run, pay_schedule_id: schedule, period_start: date, period_end: date, pay_date: date, tax_year: c.year }, "main", "document_id");
    }
  }

  if (features.inventory) inventoryRecords(c, add, location);
  if (features.propertyManagement) propertyRecords(c, add, location);
  if (features.nonprofit) nonprofitRecords(c, add, id, department);
  if (features.allocations) {
    for (const mode of ["entry", "post", "period"]) {
      const rule = add("allocation_rules", { key: `demo-${mode}-overhead`, name: `Operating overhead — ${mode}`, mode }, mode);
      const version = add("allocation_rule_versions", { rule_id: rule, version_no: 1, effective_from: date, basis_kind: "fixed_percent", basis_config: {}, memo_template: "Shared overhead distribution" }, mode);
      add("allocation_rule_targets", { version_id: version, sequence: 1, department_id: department, fixed_percent: "100.00", label: "Operations" }, mode);
    }
  }
  if (features.flows) add("flows", { name: "Demo purchase approval", description: "Independent approval of purchasing commitments.", subject_kind: "purchase_order", enabled: false, graph: { schemaVersion: 1, nodes: [{ id: "trigger", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } }, { id: "approval", position: { x: 240, y: 0 }, data: { kind: "gate", gate: { title: "Purchasing review", assignees: [{ type: "role", role: "admin" }], mode: "any", preventSelfApproval: true } } }], edges: [{ id: "to-approval", source: "trigger", target: "approval", sourceHandle: "next" }] } });
  if (features.automations) {
    const recipes = [
      { key: "date", name: "Employment onboarding follow-up", trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 30, direction: "after", atTime: "09:00" }, actions: [{ kind: "create_task", ownerKind: "initiator", title: "Review onboarding progress", dueOffsetDays: 7 }] },
      { key: "field", name: "Customer credit review", trigger: { kind: "field_change", entity: "parties", field: "is_active", to: true }, actions: [{ kind: "create_task", ownerKind: "initiator", title: "Review the customer account", dueOffsetDays: 3 }] },
      { key: "webhook", name: "Integration webhook example", trigger: { kind: "manual" }, actions: [{ kind: "webhook", endpointKey: "demo-integration" }] },
    ];
    for (const recipe of recipes) add("automations", { name: recipe.name, description: recipe.key === "field" ? "Draft field-change configuration. Event-trigger execution is not yet supported by the automation engine." : recipe.key === "webhook" ? "Draft webhook configuration. Outbound webhook delivery is not supported by the automation engine." : "Draft onboarding follow-up; review ownership and scope before enabling.", trigger: recipe.trigger, actions: recipe.actions }, recipe.key);
  }
  if (features.scripts) add("user_scripts", { name: "Demo document memo validation", trigger_point: "before_submit", document_kind: "purchase_order", source: "function main(ctx) {\n  if (!ctx.document.memo) throw new Error('Enter a purchase order memo.');\n}", is_active: false });
  if (features.apiAccess) add("api_keys", { user_id: c.actorId, name: "Revoked demo integration key", key_prefix: "ob_demo", key_hash: createHash("sha256").update(`revoked-demo-${c.orgId}`).digest("hex"), key_preview: "ob_demo_…revoked", scopes: ["documents.read"], is_active: false });
  if (features.apps) {
    const app = add("apps", { key: "demo-operations", name: "Operations extension example", description: "Draft extension demonstrating the native app packaging lifecycle.", status: "disabled" });
    const version = add("app_versions", { app_id: app, version: "1.0.1", manifest: { key: "demo-operations", name: "Operations extension example", version: "1.0.1", permissions: [], frontend: { entry: "frontend/ui.json", renderer: "native" } }, status: "draft" }, "native-1.0.1");
    // The native app starter composes the existing house page header and text blocks.
    const content = JSON.stringify({ screens: [{ key: "home", title: "Home", kind: "page", spec: { specVersion: 1, layout: "list", header: [{ kind: "page-header", title: { $: "name" } }], body: [{ kind: "text", content: "Review this native extension package before installing it. It requests no permissions and performs no writes." }] } }] });
    add("app_files", { app_id: app, version_id: version, path: "frontend/ui.json", kind: "frontend", content_type: "application/json", content, size: Buffer.byteLength(content, "utf8") }, "native-1.0.1");
  }
  if (features.aiGovernanceLedger) add("ai_capabilities", { key: "demo-finance-review", name: "Finance review assistant", purpose: "Read-only analysis of synthetic company activity.", autonomy: "read_only", enabled: false, notice_required: true });
  if (features.advancedSubscriptions) {
    const plan = add("subscription_plans", { name: "Enterprise platform subscription", description: "Versioned monthly plan with an optional support component.", amount: "2400.00", currency_code: c.currency, interval: "monthly", item_id: serviceItem, income_account_id: c.accounts.revenue, is_active: false });
    const version = add("subscription_plan_versions", { plan_id: plan, version_number: 1, effective_from: date, name: "Enterprise plan — initial terms", currency_code: c.currency, interval: "monthly", billing_timing: "advance" });
    add("subscription_plan_version_components", { version_id: version, component_key: "platform", name: "Platform licence", quantity: "1.00", unit_price: "2400.00", item_id: serviceItem, income_account_id: c.accounts.revenue });
    add("subscription_plan_version_components", { version_id: version, component_key: "support", name: "Premium support", quantity: "1.00", unit_price: "400.00", item_id: serviceItem, income_account_id: c.accounts.revenue, is_optional: true, sort_order: 10 }, "support");
  }
  return rows;
}

type AddRecord = (table: string, values: DemoRecord["values"], key?: string, primaryKey?: string) => string;
type RecordId = (table: string, key?: string) => string;

function inventoryRecords(c: DemoContext, add: AddRecord, location: string): void {
  const inventoryAccount = add("accounts", { number: "1398", name: "Demonstration stock inventory", type: "asset_current_other", is_active: true }, "inventory");
  const warehouse = add("stock_locations", { location_id: location, code: "DEMO-WH", kind: "warehouse" });
  // The stock-location service trigger creates this native warehouse row.
  // Its deterministic identity and values are adopted during read-back.
  if (sampleCompanyFeatures(c.industryKey).warehousing) add("warehouses", { stock_location_id: warehouse, name: "DEMO-WH", status: "active" }, "main", "stock_location_id");
  const component = add("items", { code: "DEMO-RAW", name: "Precision steel blank", kind: "inventory", unit: "ea", income_account_id: c.accounts.revenue, expense_account_id: c.accounts.expense, default_rate: "35.00", default_cost: "12.50" }, "component");
  const finished = add("items", { code: "DEMO-FINISHED", name: c.industryKey === "healthcare_practice" ? "Clinical supply kit" : "Precision mounting kit", kind: c.industryKey === "manufacturing" ? "assembly" : "inventory", unit: "ea", income_account_id: c.accounts.revenue, expense_account_id: c.accounts.expense, default_rate: "95.00", default_cost: "38.00" }, "finished");
  for (const [key, item] of [["component", component], ["finished", finished]] as const) add("item_inventory_profiles", { item_id: item, asset_account_id: inventoryAccount, cogs_account_id: c.accounts.expense, adjustment_account_id: c.accounts.expense, base_unit: "ea", reorder_point: "50.00", preferred_stock_level: "200.00" }, key);
  if (c.industryKey === "wholesale_distribution") {
    add("item_identifiers", { item_id: finished, kind: "internal", value: "DEMO-KIT-001", unit: "ea" });
    add("customer_item_refs", { customer_id: c.customerId, item_id: finished, customer_sku: "CUSTOMER-KIT-95", description: "Customer's purchasing reference for the mounting kit" });
    draftOrder(c, add, "customer_invoice", "DEMO-INV-STOCK-001", c.customerId, finished, "10.00", "95.00", "stock-invoice", warehouse);
    draftOrder(c, add, "rma", "DEMO-RMA-001", c.customerId, finished, "1.00", "95.00", "return", warehouse);
    const order = draftOrder(c, add, "sales_order", "DEMO-SO-001", c.customerId, finished, "10.00", "95.00", "sales");
    const purchase = draftOrder(c, add, "purchase_order", "DEMO-PO-001", c.vendorId, finished, "10.00", "38.00", "purchase");
    add("drop_ship_orders", { purchase_order_id: purchase.documentId, sales_order_id: order.documentId, ship_to_address: { line1: "125 Market Street", city: "Redbrook", country: "US" } }, "main", "purchase_order_id");
    add("drop_ship_lines", { sales_order_line_id: order.lineId, purchase_order_line_id: purchase.lineId, routed_by: c.actorId }, "main", "sales_order_line_id");
    const pick = draftOrder(c, add, "pick_list", "DEMO-PICK-001", c.customerId, finished, "10.00", "0.00", "pick");
    add("fulfillment_documents", { document_id: pick.documentId, warehouse_id: warehouse, stage: "open" }, "main", "document_id");
    add("fulfillment_lines", { line_id: pick.lineId, document_id: pick.documentId, sales_order_line_id: order.lineId }, "main", "line_id");
  }
  if (c.industryKey === "manufacturing") {
    add("bom_components", { assembly_item_id: finished, component_item_id: component, quantity_per: "2.00", effective_from: c.date });
    const center = add("mfg_work_centers", { code: "DEMO-CNC", name: "CNC machining cell", subsidiary_id: c.subsidiaryId, kind: "machine", capacity_hours_per_day: "16.00", efficiency_pct: "90.00", absorbs_overhead: true });
    const routing = add("mfg_routings", { produced_item_id: finished, code: "DEMO-KIT-ROUTE", name: "Mounting kit production", version: 1, effective_from: c.date, overhead_basis: "machine_hours", default_issue_location_id: warehouse, default_receipt_location_id: warehouse });
    add("mfg_routing_operations", { routing_id: routing, sequence: 10, name: "Machine mounting surfaces", work_center_id: center, setup_minutes: "30.00", run_minutes_per_unit: "4.00", quality_gate: "none" });
    add("mfg_work_orders", { number: "DEMO-WO-001", produced_item_id: finished, routing_id: routing, quantity_ordered: "100.00", unit: "ea", subsidiary_id: c.subsidiaryId, issue_location_id: warehouse, receipt_location_id: warehouse, planned_start: c.date, planned_end: `${c.year}-12-31` });
    for (const [key, item, method] of [["component", component, "buy"], ["finished", finished, "make"]] as const) add("mfg_item_policies", { item_id: item, supply_method: method, lead_time_days: 7, safety_stock_qty: "25.00", minimum_qty: "50.00", order_multiple_qty: "10.00", scrap_pct_planned: "2.00" }, key);
    add("mfg_mrp_runs", { number: "DEMO-MRP-001", horizon_start: c.date, horizon_end: `${c.year}-12-31`, parameters: {}, run_by: c.actorId });
  }
}

function draftOrder(c: DemoContext, add: AddRecord, kind: string, number: string, party: string, item: string, quantity: string, rate: string, key: string, stockLocationId?: string): { documentId: string; lineId: string } {
  const amount = mul(quantity, rate);
  const documentId = add("documents", { kind, document_number: number, party_id: party, document_date: c.date, currency: c.currency, subsidiary_id: c.subsidiaryId, subtotal: amount, total: amount, memo: "Synthetic order for exploring the operational workflow." }, key);
  const lineId = add("document_lines", { document_id: documentId, line_number: 1, item_id: item, account_id: kind === "purchase_order" ? c.accounts.expense : c.accounts.revenue, quantity, unit: "ea", unit_price: rate, amount, subsidiary_id: c.subsidiaryId, ...(stockLocationId ? { stock_location_id: stockLocationId } : {}) }, key);
  return { documentId, lineId };
}

function propertyRecords(c: DemoContext, add: AddRecord, location: string): void {
  for (const [key, name, type, rent] of [["residential", "Maple Court Residences", "residential", "1850.00"], ["commercial", "Lakeshore Business Centre", "commercial", "8500.00"]] as const) {
    const property = add("managed_properties", { subsidiary_id: c.subsidiaryId, location_id: location, code: `DEMO-${key.toUpperCase()}`, name, property_type: type, currency: c.currency, rent_income_account_id: c.accounts.revenue, cam_income_account_id: c.accounts.revenue, deposit_liability_account_id: c.accounts.payable, default_bank_account_id: c.accounts.bank }, key);
    const unit = add("property_units", { property_id: property, code: "101", name: type === "commercial" ? "Ground-floor retail" : "Two-bedroom apartment", rentable_area: type === "commercial" ? "4500.00" : "950.00" }, key);
    const lease = add("property_leases", { property_id: property, unit_id: unit, tenant_id: c.customerId, lease_number: `DEMO-LEASE-${key.toUpperCase()}`, starts_on: c.date, ends_on: `${c.year + 1}-12-31`, payment_terms_days: 15, security_deposit_required: rent, auto_invoice: false, notes: "Draft synthetic lease; activate through the normal lease workflow." }, key);
    add("lease_charges", { lease_id: lease, charge_type: "base_rent", description: "Monthly base rent", amount: rent, frequency: "monthly", effective_from: c.date, income_account_id: c.accounts.revenue }, key);
    add("cam_pools", { property_id: property, name: "Common-area maintenance budget", fiscal_year: c.year, period_starts_on: c.date, period_ends_on: `${c.year}-12-31`, budget_amount: "18000.00", expense_account_ids: [c.accounts.expense] }, key);
  }
}

function nonprofitRecords(c: DemoContext, add: AddRecord, id: RecordId, department: string): void {
  const segment = add("segment_definitions", { key: "fund", name: "Fund", plural_name: "Funds", source_kind: "custom", is_hierarchical: true, is_balancing: true, allow_account_requirement: true, feature_key: "fundAccounting" });
  for (const [key, name, kind] of [["operating", "Operating fund", "operating"], ["youth", "Youth education restriction", "restricted"], ["endowment", "Community endowment", "endowment"]] as const) {
    const value = add("segment_values", { segment_id: segment, code: `DEMO-${key.toUpperCase()}`, name }, key);
    add("funds", { id: value, kind, restriction_class: kind === "operating" ? "without_donor_restrictions" : "with_donor_restrictions", budgetary_control: "advisory" }, key);
  }
  const fund = id("segment_values", "youth");
  const group = add("account_groups", { dimension: "account", key: "demo-allowable-costs", name: "Program allowable costs", match: { types: ["expense", "cogs"] } });
  add("nonprofit_frameworks", { framework: "us_asc958", set_by: c.actorId, reason: "Synthetic US nonprofit demonstration" });
  add("grants", { code: "DEMO-YOUTH-2026", name: "Youth learning programme award", sponsor_party_id: c.customerId, sponsor_kind: "foundation", determination: "contribution_conditional", barrier: "Deliver four quarterly learning programmes", right_of_return: true, award_amount: "240000.00", period_from: c.date, period_to: `${c.year + 1}-12-31`, fund_id: fund, allowable_account_group_id: group });
  const pledge = add("pledges", { subsidiary_id: c.subsidiaryId, pledge_number: "DEMO-PLEDGE-001", donor_party_id: c.customerId, fund_id: fund, total_amount: "60000.00" });
  add("pledge_installments", { pledge_id: pledge, installment_number: 1, due_on: `${c.year}-12-31`, amount: "30000.00" });
  add("pledge_installments", { pledge_id: pledge, installment_number: 2, due_on: `${c.year + 1}-12-31`, amount: "30000.00" }, "second");
  add("encumbrances", { encumbrance_number: "DEMO-ENC-001", source_kind: "manual", account_id: c.accounts.expense, subsidiary_id: c.subsidiaryId, department_id: department, extra_dims: { fund }, amount: "12000.00" });
  add("functional_mappings", { department_id: department, function: "program", program_key: "youth-learning", effective_from: c.date });
}
