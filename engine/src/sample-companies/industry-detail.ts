import { sampleCompanyFeatures } from "./features.ts";
import { INDUSTRY_OPERATIONS, type AddDemoRecord } from "./industry-operations.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";

export const INDUSTRY_STOCK: Record<string, readonly string[]> = {
  wholesale_distribution: ["Galvanized mounting bracket", "Industrial safety gloves", "Weatherproof cable gland", "Maintenance fastener assortment"],
  manufacturing: ["Aluminium housing blank", "Precision bearing insert", "Protective enclosure", "Control panel mounting plate"],
  healthcare_practice: ["Sterile dressing pack", "Examination glove carton", "Diagnostic sample container", "Patient-care supply kit"],
  general_business: ["Facilities consumables kit", "Office replenishment carton", "Storage bin set", "Cleaning supply pack"],
};

/** Industry children are attached to named parent records, not disconnected filler. */
export function industryDetailRecords(c: DemoContext, add: AddDemoRecord): void {
  const f = sampleCompanyFeatures(c.industryKey);
  const id = (table: string, key = "main") => scenarioRecordId(c, table, key);
  if (f.inventory) (INDUSTRY_STOCK[c.industryKey] ?? []).forEach((name, index) => {
    const key = `operating-stock-${index + 1}`;
    const item = add("items", { code: `DEMO-STOCK-${index + 1}`, name, kind: "inventory", unit: "ea",
      income_account_id: c.accounts.revenue, expense_account_id: c.accounts.expense,
      default_cost: ["12.50", "24.00", "38.00", "16.75"][index]!, default_rate: ["35.00", "48.00", "95.00", "42.50"][index]! }, key);
    add("item_inventory_profiles", { item_id: item, asset_account_id: id("accounts", "inventory"), cogs_account_id: c.accounts.expense,
      adjustment_account_id: c.accounts.expense, base_unit: "ea", reorder_point: "25.00", preferred_stock_level: "150.00" }, key);
    if (f.barcodeScanning) add("item_identifiers", { item_id: item, kind: "internal", value: `DEMO-STOCK-${index + 1}`, unit: "ea" }, key);
    if (f.customerPartNumbers) add("customer_item_refs", { item_id: item, customer_id: id("parties", `operations-customer-${index + 1}`), customer_sku: `TRADE-${index + 1}`, description: name }, key);
  });
  for (let n = 1; n <= 3; n++) {
    const key = `operating-detail-${n}`;
    const customer = id("parties", `operations-customer-${n}`);
    const vendor = id("parties", `operations-vendor-${n}`);
    const project = f.projects ? id("projects", `operations-project-${n}`) : null;
    if (project && f.subcontracts) {
      const subcontract = add("subcontracts", { project_id: project, vendor_id: vendor, number: `DEMO-SUB-${n}`, title: `${INDUSTRY_OPERATIONS[c.industryKey]!.vendors[n - 1]} delivery package`, currency: c.currency, original_commitment: "24000.00", default_retainage_percent: "10.00", starts_on: c.date, ends_on: `${c.year}-12-31` }, key);
      for (const [line, label, amount] of [["01", "Mobilization and first delivery", "8000.00"], ["02", "Completion and review", "16000.00"]] as const) add("subcontract_sov_lines", { subcontract_id: subcontract, item_no: line, description: label, scheduled_value: amount, retainage_percent: "10.00", expense_account_id: c.accounts.expense }, `${key}-${line}`);
    }
    if (project && f.preBilling) add("prebills", { project_id: project, worksheet_number: `DEMO-REVIEW-${n}`, period_start: c.date, period_end: `${c.year}-12-31`, notes: "Draft review of engagement scope and eligible work before billing." }, key);
    if (project && f.fieldTickets) {
      const ticket = add("documents", { kind: "field_ticket", document_number: `DEMO-SITE-${n}`, party_id: customer, project_id: project, document_date: c.date, subsidiary_id: c.subsidiaryId, currency: c.currency, memo: `Site daily report — ${INDUSTRY_OPERATIONS[c.industryKey]!.engagements[n - 1]}` }, key);
      add("field_tickets", { document_id: ticket, period: "daily", period_start: c.date, period_end: c.date, foreman_party_id: c.employeeId }, key, "document_id");
      for (let stage = 1; stage <= 3; stage++) add("time_entries", { employee_party_id: c.employeeId,
        worked_on: c.date, project_id: project, project_task_id: id("project_tasks", `operations-project-${n}-task-${stage}`),
        field_ticket_id: ticket, item_id: id("items", `operations-service-${stage}`), time_type_id: id("time_types"),
        hours: ["2.00", "3.50", "1.00"][stage - 1]!, memo: "Draft site activity awaiting independent time and ticket review", is_billable: true,
      }, `${key}-site-time-${stage}`);
    }
    if (f.fixedAssets) add("fixed_assets", { category_id: id("asset_categories"), asset_number: `DEMO-EQUIPMENT-${n}`, name: c.industryKey === "healthcare_practice" ? ["Examination station", "Portable diagnostic unit", "Clinical records workstation"][n - 1]! : ["Operations workstation group", "Service equipment package", "Office fit-out package"][n - 1]!, subsidiary_id: c.subsidiaryId, acquired_on: c.date, acquisition_cost: ["12000.00", "18500.00", "24000.00"][n - 1]!, salvage_value: "1000.00", description: "Draft acquisition; review the source bill and capitalization policy before placing in service." }, key);
    if (f.equipment) add("equipment_units", { subsidiary_id: c.subsidiaryId, unit_number: `DEMO-UNIT-${n}`, name: ["Site survey instrument", "Portable service kit", "Material handling unit"][n - 1]!, purchase_price: ["2400.00", "6800.00", "14500.00"][n - 1]!, acquired_on: c.date }, key);
    if (f.propertyManagement) {
      const property = id("managed_properties", n < 3 ? "residential" : "commercial");
      const unit = add("property_units", { property_id: property, code: String(201 + n), name: n < 3 ? `Courtyard apartment ${n}` : "Second-floor professional suite", rentable_area: n < 3 ? "950.00" : "2400.00" }, key);
      const lease = add("property_leases", { property_id: property, unit_id: unit, tenant_id: customer, lease_number: `DEMO-OCCUPANCY-${n}`, starts_on: c.date, ends_on: `${c.year + 1}-12-31`, payment_terms_days: 15, security_deposit_required: n < 3 ? "1950.00" : "4800.00", auto_invoice: false, notes: "Draft occupancy terms awaiting review and native activation." }, key);
      add("lease_charges", { lease_id: lease, charge_type: "base_rent", description: "Monthly base rent", amount: n < 3 ? "1950.00" : "4800.00", frequency: "monthly", effective_from: c.date, income_account_id: c.accounts.revenue }, key);
    }
    if (f.nonprofit) {
      const fund = id("segment_values", "youth");
      add("grants", { code: `DEMO-AWARD-${n}`, name: ["After-school learning", "Neighbourhood food access", "Accessible community events"][n - 1]!, sponsor_party_id: customer, sponsor_kind: "foundation", determination: "contribution_conditional", barrier: "Deliver the agreed programme and submit its activity report", right_of_return: true, award_amount: ["48000.00", "72000.00", "36000.00"][n - 1]!, period_from: c.date, period_to: `${c.year + 1}-12-31`, fund_id: fund, allowable_account_group_id: id("account_groups") }, key);
      const pledge = add("pledges", { subsidiary_id: c.subsidiaryId, pledge_number: `DEMO-GIVING-${n}`, donor_party_id: customer, fund_id: fund, total_amount: "12000.00" }, key);
      for (const year of [c.year, c.year + 1]) add("pledge_installments", { pledge_id: pledge, installment_number: year === c.year ? 1 : 2, due_on: `${year}-12-31`, amount: "6000.00" }, `${key}-${year === c.year ? "first" : "second"}`);
    }
    if (f.manufacturing) add("mfg_work_orders", { number: `DEMO-BATCH-${n}`, produced_item_id: id("items", "finished"), routing_id: id("mfg_routings"), quantity_ordered: ["25.00", "50.00", "75.00"][n - 1]!, unit: "ea", subsidiary_id: c.subsidiaryId, issue_location_id: id("stock_locations"), receipt_location_id: id("stock_locations"), planned_start: c.date, planned_end: `${c.year}-12-31` }, key);
  }
}
