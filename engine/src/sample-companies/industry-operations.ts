import { sampleOperatingPolicy } from "./policy.ts";
import { mul, neg } from "../money/money.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { scenarioRecordId, type DemoContext, type DemoRecord } from "./scenarios.ts";

/** Commercial examples are synthetic operating assumptions, never statutory rates. */
export const INDUSTRY_OPERATIONS: Record<string, {
  customers: readonly string[]; vendors: readonly string[]; services: readonly string[]; engagements: readonly string[];
}> = {
  general_business: { customers: ["Oak Street Hardware", "Willow Facilities", "Brookside Offices", "Elmwood Community Centre"], vendors: ["Cedar Packaging", "Stonebridge Couriers", "Northgate Office Supply", "Juniper IT Services", "Maple Commercial Leasing", "Clearwater Utilities"], services: ["Facilities supply delivery", "Monthly replenishment", "Installation support", "Stockroom organization"], engagements: ["Office supply rollout", "Community centre opening", "Regional replenishment programme"] },
  construction_contractor: { customers: ["Riverfront Developments", "Pinecrest Housing", "Lakeside School Board", "Foundry Business Park"], vendors: ["Granite Concrete Supply", "Apex Electrical", "Bluewater Mechanical", "Ridge Equipment Hire", "Keystone Aggregates", "SiteSafe Services"], services: ["Site mobilization", "Concrete placement", "Interior fit-out", "Commissioning support"], engagements: ["Pinecrest accessible housing", "Lakeside classroom expansion", "Foundry warehouse retrofit"] },
  professional_services: { customers: ["Beacon Retail Group", "Orchard Foods", "Bridgewater Logistics", "Evergreen Hospitality"], vendors: ["ResearchWorks Data", "Workshop Space Partners", "Studio Presentation Design", "Insight Survey Services", "Advisory Software Cooperative", "Regional Business Travel"], services: ["Operating model assessment", "Management workshop", "Market research", "Implementation advisory"], engagements: ["Beacon operating model", "Orchard market entry", "Bridgewater process improvement"] },
  engineering_architecture: { customers: ["Westhaven Properties", "Civic Infrastructure Group", "Harbour Transit", "Meadowland Schools"], vendors: ["Contour Surveying", "Terra Geotechnical", "Spectrum Building Science", "Plotline Reprographics", "DesignGrid Software", "Field Instrument Rentals"], services: ["Concept design", "Structural assessment", "Construction administration", "Site inspection"], engagements: ["Westhaven mixed-use concept", "Harbour transit accessibility", "Meadowland learning centre"] },
  it_software_saas: { customers: ["Lumen Analytics", "Spruce Commerce", "Prairie Workflow", "Coastal Support Systems"], vendors: ["Nimbus Cloud Hosting", "Signal Observability", "Shield Security Review", "Developer Tools Collective", "Customer Success Academy", "Network Transit Partners"], services: ["Platform onboarding", "Data migration", "Premium support", "Integration workshop"], engagements: ["Lumen enterprise rollout", "Spruce integration programme", "Coastal support migration"] },
  accounting_firm: { customers: ["Rosewood Dental Group", "Summit Family Holdings", "Market Lane Restaurants", "Copperleaf Engineering"], vendors: ["Practice Software Partners", "Professional Research Library", "Secure Records Storage", "Continuing Education Centre", "Office Services Collective", "Independent Review Associates"], services: ["Monthly bookkeeping", "Financial statement preparation", "Management reporting", "Controller advisory"], engagements: ["Rosewood monthly close", "Summit reporting package", "Market Lane cost review"] },
  wholesale_distribution: { customers: ["Central Industrial Stores", "Lakeshore Maintenance", "Redwood Trade Counter", "Valley Assembly Partners"], vendors: ["Precision Fastener Works", "Summit Safety Supply", "Harbour Packaging", "Freightline Transport", "Rackspace Warehouse Equipment", "Distribution Systems Support"], services: ["Scheduled replenishment", "Kitting service", "Expedited delivery", "Inventory planning support"], engagements: ["Central stocking programme", "Valley assembly launch", "Lakeshore replenishment route"] },
  property_management: { customers: ["Maple Court Residents", "Lakeshore Retail Partners", "Parkview Office Tenants", "Willow Court Owners"], vendors: ["Greenway Landscaping", "Comfort Mechanical Services", "BrightHall Cleaning", "Property Lift Maintenance", "Northside Security", "Roofline Repairs"], services: ["Property management fee", "Tenant fit-out coordination", "Maintenance supervision", "Portfolio reporting"], engagements: ["Maple Court maintenance plan", "Parkview tenant improvements", "Willow Court reserve study"] },
  nonprofit: { customers: ["Community Giving Circle", "Regional Learning Foundation", "Neighbourhood Partners", "Bright Futures Sponsors"], vendors: ["Community Meal Cooperative", "Learning Materials Collective", "Accessible Transport Services", "Neighbourhood Venue Partners", "Programme Evaluation Associates", "Volunteer Support Supplies"], services: ["Community programme sponsorship", "Learning programme contribution", "Workshop participation", "Programme administration"], engagements: ["Youth learning programme", "Community food access", "Accessible neighbourhood activities"] },
  manufacturing: { customers: ["Vector Equipment Builders", "Harbour Assembly Systems", "Pioneer Industrial Products", "Oakridge Machinery"], vendors: ["Alloy Steel Supply", "Precision Tooling Works", "Surface Finish Partners", "Industrial Controls Supply", "Plant Equipment Leasing", "FreightRail Logistics"], services: ["Prototype engineering", "Production setup", "Quality inspection", "Assembly support"], engagements: ["Vector mounting system", "Pioneer enclosure launch", "Oakridge tooling improvement"] },
  healthcare_practice: { customers: ["Evergreen Benefits Group", "Northstar Care Network", "Community Wellness Partners", "Patient Services Cooperative"], vendors: ["Clinical Supply Partners", "Diagnostic Services Group", "Clinic Property Partners", "Health Records Cloud", "Medical Equipment Service", "Care Team Education"], services: ["Practice administration service", "Wellness programme delivery", "Care coordination", "Clinical records service"], engagements: ["Community wellness programme", "Care network onboarding", "Practice access improvement"] },
};

export type AddDemoRecord = (table: string, values: DemoRecord["values"], key?: string, primaryKey?: string) => string;

export function industryOperatingRecords(c: DemoContext, add: AddDemoRecord): void {
  const profile = INDUSTRY_OPERATIONS[c.industryKey];
  if (!profile) throw new Error(`Missing operating scenarios for ${c.industryKey}`);
  const features = sampleCompanyFeatures(c.industryKey);
  for (const [role, names] of [["customer", profile.customers], ["vendor", profile.vendors]] as const) {
    names.forEach((name, index) => {
      const key = `operations-${role}-${index + 1}`;
      const party = add("parties", { kind: "company", display_name: name, is_active: true }, key);
      add(`${role}_roles`, { party_id: party }, key);
    });
  }
  profile.services.forEach((name, index) => add("items", {
    code: `DEMO-OPS-SVC-${index + 1}`, name, kind: "service", unit: "each",
    income_account_id: c.accounts.revenue, expense_account_id: c.accounts.expense,
    default_rate: ["450.00", "1250.00", "275.00", "850.00"][index]!, show_on_timesheet: features.timeTracking,
  }, `operations-service-${index + 1}`));
  // Orders and expenses use the native authored-scenario draft path; their
  // application writers are web-owned. Approval and posting remain domain commands.
  for (const spec of operatingDocuments(c).filter(spec => ["quote", "sales_order", "purchase_order", "expense_report"].includes(spec.kind))) {
    const document = add("documents", { kind: spec.kind, document_number: `DEMO-${spec.key.toUpperCase()}`,
      party_id: spec.partyId, subsidiary_id: c.subsidiaryId, document_date: spec.documentDate,
      currency: c.currency, memo: spec.description, subtotal: spec.amount, total: spec.amount,
      external_source: "industry_demo", external_ref: spec.key }, spec.key);
    add("document_lines", { document_id: document, line_number: 1, account_id: spec.accountId,
      description: spec.description, quantity: spec.quantity, unit_price: spec.unitPrice, amount: spec.amount,
      subsidiary_id: c.subsidiaryId }, spec.key);
  }
  if (features.projects) profile.engagements.forEach((name, index) => {
    const project = add("projects", { code: `DEMO-OPS-PROJ-${index + 1}`, name,
      customer_id: scenarioRecordId(c, "parties", `operations-customer-${index + 1}`),
      subsidiary_id: c.subsidiaryId, starts_on: c.date, ends_on: `${c.year}-12-31`,
      notes: "Synthetic delivery engagement with scope, budget and work awaiting normal operational approval." }, `operations-project-${index + 1}`);
    ["Discovery and planning", "Delivery", "Review and handover"].forEach((name, stage) => {
      add("project_tasks", { project_id: project, code: `STAGE-${stage + 1}`, name, schedule_order: (stage + 1) * 10, ...(features.projectProgress ? { budget_quantity: "100.00", budget_unit: "m2" } : {}) }, `operations-project-${index + 1}-task-${stage + 1}`);
      if (features.timeTracking) add("time_entries", { employee_party_id: c.employeeId, worked_on: c.date,
        project_id: project, hours: ["2.00", "3.50", "1.00"][stage]!, item_id: scenarioRecordId(c, "items", `operations-service-${stage + 1}`),
        time_type_id: scenarioRecordId(c, "time_types", "main"), memo: name, is_billable: true,
        cost_rate: "65.00", bill_rate: "175.00" }, `operations-project-${index + 1}-time-${stage + 1}`);
    });
  });
}

export interface OperatingDocument {
  key: string; kind: string; documentDate: string; partyId: string; accountId: string; description: string; quantity: string; unitPrice: string; amount: string; post: boolean;
}

/** Several operational cycles leave both posted evidence and useful editable work. */
export function operatingDocuments(c: DemoContext): OperatingDocument[] {
  const profile = INDUSTRY_OPERATIONS[c.industryKey]!;
  const features = sampleCompanyFeatures(c.industryKey);
  const policy = sampleOperatingPolicy(c.industryKey);
  const result: OperatingDocument[] = [];
  const examples = policy.examplesPerOtherKind;
  const kinds: Array<[string, number, "vendor" | "customer" | "employee"]> = [
    ["vendor_bill", policy.vendorBills, "vendor"], ["customer_invoice", policy.customerInvoices, "customer"],
    ["check", examples, "vendor"], ["deposit", examples, "customer"], ["card_charge", examples, "vendor"], ["card_refund", examples, "vendor"], ["transfer", examples, "vendor"],
    ["vendor_credit", examples, "vendor"], ["customer_credit", examples, "customer"], ["expense_report", examples, "employee"],
    ...(features.orders ? [["quote", examples, "customer"], ["sales_order", examples, "customer"], ["purchase_order", examples * 2, "vendor"]] as Array<[string, number, "vendor" | "customer"]> : []),
    ...(features.cashSales ? [["cash_sale", examples, "customer"], ["cash_refund", examples, "customer"]] as Array<[string, number, "customer"]> : []),
  ];
  for (const [kind, count, role] of kinds) for (let index = 0; index < count; index++) {
    const vendor = role === "vendor";
    const expense = vendor || role === "employee";
    const names = vendor ? profile.vendors : profile.customers;
    const basePrice = expense ? ["125.00", "480.00", "1250.00", "3600.00", "875.00", "225.00"][index % 6]! : ["450.00", "1250.00", "275.00", "850.00"][index % 4]!;
    // Card refunds store signed detail; credit memos and cash refunds reverse positive detail in their native posting rules.
    const unitPrice = kind === "card_refund" ? neg(basePrice) : kind.endsWith("_credit") ? mul(basePrice, "0.10") : basePrice;
    const quantity = `${index % 3 + 1}.00`;
    result.push({ key: `operations-${kind}-${index + 1}`, kind, documentDate: c.operationDates?.[index % c.operationDates.length] ?? c.operationDate ?? c.date,
      partyId: role === "employee" ? c.employeeId : scenarioRecordId(c, "parties", `operations-${role}-${index % names.length + 1}`),
      accountId: expense ? c.accounts.expense : c.accounts.revenue,
      description: vendor ? `${names[index % names.length]} — ${["scheduled supply", "service visit", "monthly operating charge"][Math.floor(index / 6) % 3]}` : role === "employee" ? ["Client-site mileage and parking", "Project workshop supplies", "Business travel reimbursement"][index]! : profile.services[index % profile.services.length]!,
      quantity, unitPrice, amount: mul(quantity, unitPrice),
      post: (kind === "vendor_bill" && index < policy.postedVendorBills) || (kind === "customer_invoice" && index < policy.postedCustomerInvoices) || (["vendor_credit", "customer_credit", "expense_report", "check", "deposit", "card_charge", "card_refund", "transfer", "cash_sale", "cash_refund"].includes(kind) && index < 2),
    });
  }
  return result;
}
