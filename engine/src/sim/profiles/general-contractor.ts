import type { CoaEntry, JobSpec, Profile } from "./types.ts";

/**
 * A contractor's own chart — job-cost structured and distinctly named vs. the
 * services chart: contracts receivable + retainage, costs/billings in excess
 * (under/over-billings), a job-cost (COGS) block split labor/materials/subs/
 * equipment, Work-in-Process + Labor Clearing for the T&M labor flow, and an
 * equipment-heavy fixed-asset block. `laborWip` is the direct-labor job-cost
 * account (so approved crew time lands in COGS and T&M gross margin is real);
 * `laborClearing` holds the offset until payroll washes it.
 */
const CONSTRUCTION_COA: CoaEntry[] = [
  // Assets
  ["bank", "1010", "Operating Account", "asset_bank"],
  ["bankPayroll", "1020", "Payroll Account", "asset_bank"],
  ["bankSavings", "1030", "Contract Reserve", "asset_bank"],
  ["ar", "1200", "Contracts Receivable", "asset_receivable"],
  ["retainageReceivable", "1210", "Retainage Receivable", "asset_receivable"],
  ["allowanceDoubtful", "1290", "Allowance for Doubtful Contracts", "asset_current_other"],
  ["underBillings", "1250", "Costs & Est. Earnings in Excess of Billings", "asset_current_other"],
  ["prepaid", "1300", "Prepaid Expenses", "asset_current_other"],
  ["prepaidInsurance", "1310", "Prepaid Insurance & Bonds", "asset_current_other"],
  ["inventory", "1350", "Materials Inventory", "asset_current_other"],
  ["taxInput", "1360", "Recoverable Sales Tax", "asset_current_other"],
  ["deposits", "1400", "Deposits", "asset_other"],
  ["equipment", "1500", "Construction Equipment", "asset_fixed"],
  ["vehicles", "1510", "Trucks & Vehicles", "asset_fixed"],
  ["furniture", "1520", "Office Furniture & Fixtures", "asset_fixed"],
  ["leasehold", "1530", "Yard & Shop Improvements", "asset_fixed"],
  ["accumDep", "1590", "Accumulated Depreciation", "asset_fixed"],
  // Liabilities
  ["ap", "2010", "Accounts Payable — Trade", "liability_payable"],
  ["creditCard", "2050", "Company Credit Cards", "liability_card"],
  ["accrued", "2100", "Accrued Expenses", "liability_current_other"],
  ["employeePayable", "2110", "Employee Reimbursements", "liability_current_other"],
  ["accruedPayroll", "2120", "Accrued Payroll & Union", "liability_current_other"],
  ["laborClearing", "2130", "Labor Clearing", "liability_current_other"],
  ["overBillings", "2200", "Billings in Excess of Costs", "liability_current_other"],
  ["deferredRevenue", "2210", "Customer Deposits", "liability_current_other"],
  ["taxOutput", "2250", "Sales Tax Payable", "liability_current_other"],
  ["payrollTaxPayable", "2260", "Payroll Taxes Payable", "liability_current_other"],
  ["retainagePayable", "2300", "Retainage Payable — Subs", "liability_current_other"],
  ["currentDebt", "2400", "Current Portion — Equipment Notes", "liability_current_other"],
  ["lineOfCredit", "2700", "Line of Credit", "liability_long_term"],
  ["notesPayable", "2800", "Equipment Notes Payable", "liability_long_term"],
  // Equity
  ["commonStock", "3000", "Common Stock", "equity"],
  ["apic", "3100", "Paid-In Capital", "equity"],
  ["retainedEarnings", "3200", "Retained Earnings", "equity"],
  ["distributions", "3300", "Shareholder Distributions", "equity"],
  ["openingBalanceEquity", "3900", "Opening Balance Equity", "equity"],
  // Income
  ["revenueService", "4000", "Contract Revenue — Labor", "income"],
  ["revenueProduct", "4010", "Contract Revenue — Materials", "income"],
  ["revenueConsulting", "4020", "Change Order Revenue", "income"],
  ["equipmentRevenue", "4030", "Equipment Rental Revenue", "income"],
  ["otherIncome", "4900", "Other Income", "income_other"],
  ["interestIncome", "4910", "Interest Income", "income_other"],
  // Job costs (COGS)
  ["cogs", "5000", "Job Cost — Other", "cogs"],
  ["materials", "5100", "Job Cost — Materials", "cogs"],
  ["subcontractor", "5200", "Job Cost — Subcontractors", "cogs"],
  ["directLabor", "5300", "Job Cost — Payroll Labor", "cogs"],
  ["laborWip", "5350", "Job Cost — Field Labor (T&M crews)", "cogs"],
  ["equipmentRental", "5400", "Job Cost — Equipment", "cogs"],
  ["jobTravel", "5130", "Job Cost — Travel & Per Diem", "cogs"],
  // Overhead (operating expenses)
  ["payroll", "6000", "Office Salaries", "expense"],
  ["benefits", "6010", "Employee Benefits", "expense"],
  ["payrollTaxExpense", "6020", "Payroll Taxes — Overhead", "expense"],
  ["rent", "6100", "Rent", "expense"],
  ["utilities", "6200", "Utilities & Fuel", "expense"],
  ["insurance", "6300", "Insurance & Bonds", "expense"],
  ["office", "6400", "Office & Software", "expense"],
  ["professionalFees", "6500", "Professional Fees", "expense"],
  ["marketing", "6550", "Marketing", "expense"],
  ["badDebt", "6600", "Bad Debt Expense", "expense"],
  ["travel", "6650", "Travel & Vehicle", "expense"],
  ["meals", "6660", "Meals", "expense"],
  ["depreciation", "6700", "Depreciation Expense", "expense"],
  ["bankFees", "6800", "Bank & Financing Fees", "expense"],
  ["miscExpense", "6900", "Miscellaneous", "expense_other"],
  ["interestExpense", "7000", "Interest Expense", "expense_other"],
  ["fxGainLoss", "7010", "Realized FX Gain/Loss", "expense_other"],
];

/**
 * A larger, multi-method general contractor modeled on a real reference
 * contractor's job cost→bill fidelity. Bigger than the reference: a 12-person field
 * crew across a concurrent portfolio of ~16 jobs running EVERY billing method at
 * once — T&M, AIA schedule-of-values (with retainage), fixed-price milestones,
 * not-to-exceed, and cost-plus. Revenue is FULLY BOTTOM-UP: crews log field
 * tickets against jobs daily, labor cost flows through the ledger, and the PM
 * autopilot bills each job per its method monthly (labor at bill rate + equipment
 * at a day rate against the owned fleet + materials at a markup). There is NO
 * injected misc revenue (invoicesPerDay: 0) — job-level gross margin lands ~40-48%
 * and company net ~8-12% after overhead, exactly as the real books read.
 */
const CREW: NonNullable<Profile["workforce"]> = [
  { name: "Miguel Torres (General Foreman)", costRate: "78.00", billRate: "180.00" },
  { name: "Rosa Delgado (Equip. Operator)", costRate: "66.00", billRate: "155.00" },
  { name: "Dwayne Ellis (Journeyman)", costRate: "58.00", billRate: "138.00" },
  { name: "Priya Nair (Journeyman)", costRate: "56.00", billRate: "135.00" },
  { name: "Kenji Watanabe (Journeyman)", costRate: "57.00", billRate: "136.00" },
  { name: "Luis Ferreira (Welder)", costRate: "62.00", billRate: "150.00" },
  { name: "Tomas Novak (Pipefitter)", costRate: "61.00", billRate: "148.00" },
  { name: "Grace Okafor (Millwright)", costRate: "60.00", billRate: "145.00" },
  { name: "Ravi Kapoor (Equip. Operator)", costRate: "64.00", billRate: "152.00" },
  { name: "Sam Whitaker (Apprentice)", costRate: "40.00", billRate: "98.00" },
  { name: "Ade Balogun (Apprentice)", costRate: "38.00", billRate: "95.00" },
  { name: "Chloe Martin (Apprentice)", costRate: "39.00", billRate: "96.00" },
];

/** A schedule of values summing to `total`, split into standard GC divisions. */
function sov(total: number): JobSpec["sovLines"] {
  const split: [string, number][] = [
    ["General Conditions", 0.08], ["Sitework & Excavation", 0.14], ["Concrete & Foundations", 0.18],
    ["Structural Steel", 0.16], ["Mechanical & Plumbing", 0.17], ["Electrical", 0.13],
    ["Finishes", 0.10], ["Closeout & Commissioning", 0.04],
  ];
  return split.map(([description, pct]) => ({ description, scheduledValue: Math.round(total * pct) }));
}

// monthlyMaterials bundles ALL purchased job cost (materials, small subs, rentals),
// billed via each job's method. Kept in balance with field labor (~$90K/mo) so the
// cost mix reads like a self-performing GC, not a materials broker.
const PORTFOLIO: JobSpec[] = [
  // --- AIA schedule-of-values: large building contracts, progress draws + retainage ---
  { customer: "Municipal School District #7", name: "Lincoln Middle School Addition", code: "JOB-SOV-01", method: "schedule_of_values", sovLines: sov(4200000), crewSize: 4, equipment: true, monthlyMaterials: 12000 },
  { customer: "Harborview Development LLC", name: "Harborview Tower Podium", code: "JOB-SOV-02", method: "schedule_of_values", sovLines: sov(6800000), crewSize: 4, equipment: true, monthlyMaterials: 18000 },
  { customer: "Northgate Industrial REIT", name: "Northgate Distribution Center", code: "JOB-SOV-03", method: "schedule_of_values", sovLines: sov(3100000), crewSize: 3, equipment: true, monthlyMaterials: 9000 },
  { customer: "State DOT Region 4", name: "Route 9 Overpass Rehab", code: "JOB-SOV-04", method: "schedule_of_values", sovLines: sov(2400000), crewSize: 3, equipment: true, monthlyMaterials: 7500 },
  // --- Fixed-price: defined-scope milestone billing ---
  { customer: "Riverside Retail Partners", name: "Riverside Plaza Tenant Buildout", code: "JOB-FP-01", method: "fixed_price", contractValue: 980000, crewSize: 2, equipment: false, monthlyMaterials: 4000 },
  { customer: "Northgate Industrial REIT", name: "Northgate Warehouse Reroof", code: "JOB-FP-02", method: "fixed_price", contractValue: 640000, crewSize: 2, equipment: true, monthlyMaterials: 3000 },
  { customer: "Harborview Development LLC", name: "Marina Clubhouse Shell", code: "JOB-FP-03", method: "fixed_price", contractValue: 1350000, crewSize: 3, equipment: true, monthlyMaterials: 5500 },
  // --- Time & materials: service/maintenance/emergency work, billed monthly ---
  { customer: "Riverside Retail Partners", name: "Riverside Mall Facilities T&M", code: "JOB-TM-01", method: "time_and_materials", contractValue: 0, crewSize: 2, equipment: false, monthlyMaterials: 2000 },
  { customer: "Northgate Industrial REIT", name: "Northgate Plant Maintenance T&M", code: "JOB-TM-02", method: "time_and_materials", contractValue: 0, crewSize: 2, equipment: true, monthlyMaterials: 2500 },
  { customer: "Harborview Development LLC", name: "Harborview Punchlist & Warranty", code: "JOB-TM-03", method: "time_and_materials", contractValue: 0, crewSize: 1, equipment: false, monthlyMaterials: 1000 },
  // --- Not-to-exceed: capped T&M ---
  { customer: "State DOT Region 4", name: "Bridge Inspection Repairs (NTE)", code: "JOB-NTE-01", method: "not_to_exceed", contractValue: 720000, crewSize: 2, equipment: true, monthlyMaterials: 2000 },
  { customer: "Municipal School District #7", name: "District HVAC Upgrades (NTE)", code: "JOB-NTE-02", method: "not_to_exceed", contractValue: 540000, crewSize: 2, equipment: false, monthlyMaterials: 2500 },
  // --- Cost-plus: negotiated cost + fee ---
  { customer: "Harborview Development LLC", name: "Harborview Amenity Fit-out (CP)", code: "JOB-CP-01", method: "cost_plus", contractValue: 0, crewSize: 2, equipment: false, monthlyMaterials: 3500 },
  { customer: "Northgate Industrial REIT", name: "Northgate Cold Storage (CP)", code: "JOB-CP-02", method: "cost_plus", contractValue: 0, crewSize: 3, equipment: true, monthlyMaterials: 6500 },
];

export const generalContractor: Profile = {
  id: "general-contractor",
  name: "Summit Ridge Construction",
  industry: "construction",
  baseCurrency: "USD",
  country: "US",
  coa: CONSTRUCTION_COA,
  openingScale: 3.5,
  workforce: CREW,
  jobPortfolio: PORTFOLIO,
  equipmentDayRate: 380,
  materialMarkup: 0.15,
  officeOverheadPerMonth: 40000, // PMs, estimators, admin, yard — office staff beyond the field crew
  utilization: 0.82,
  vendors: [
    // Job-cost vendors — bills tagged to jobs via the AP cycle (real job costing).
    { name: "Cascade Building Supply", termDays: 30, expenseCategories: ["materials"], billMin: 800, billMax: 40000 },
    { name: "Ironclad Steel & Rebar", termDays: 45, expenseCategories: ["materials"], billMin: 2000, billMax: 60000 },
    { name: "Delta Electrical Subs", termDays: 30, expenseCategories: ["subcontractor"], billMin: 5000, billMax: 55000 },
    { name: "Peak Plumbing Contractors", termDays: 30, expenseCategories: ["subcontractor"], billMin: 4000, billMax: 45000 },
    { name: "Apex Mechanical Subs", termDays: 30, expenseCategories: ["subcontractor"], billMin: 6000, billMax: 60000 },
    { name: "United Equipment Rental", termDays: 30, expenseCategories: ["equipmentRental"], billMin: 1500, billMax: 22000 },
    // Overhead vendors.
    { name: "Statewide Insurance & Bonding", termDays: 30, expenseCategories: ["insurance"], billMin: 3000, billMax: 12000 },
    { name: "City Utilities", termDays: 21, expenseCategories: ["utilities"], billMin: 600, billMax: 3500 },
    { name: "Anderson Legal & Bonding", termDays: 30, expenseCategories: ["professionalFees"], billMin: 1200, billMax: 9000 },
    { name: "Fleet Fuel & Maintenance", termDays: 30, expenseCategories: ["utilities", "travel"], billMin: 1500, billMax: 9000 },
    { name: "Yard & Office Landlord", termDays: 15, expenseCategories: ["rent"], billMin: 14000, billMax: 14000 },
    { name: "BuildTech Software & IT", termDays: 30, expenseCategories: ["office"], billMin: 1500, billMax: 6000 },
  ],
  customers: [
    { name: "Harborview Development LLC", termDays: 45, revenueCategories: ["revenueService"], invoiceMin: 25000, invoiceMax: 400000, payment: { onTime: 0.3, late: 0.4, veryLate: 0.2, shortPay: 0.07, delinquent: 0.03 } },
    { name: "Municipal School District #7", termDays: 60, revenueCategories: ["revenueService"], invoiceMin: 50000, invoiceMax: 650000, payment: { onTime: 0.5, late: 0.35, veryLate: 0.1, shortPay: 0.03, delinquent: 0.02 } },
    { name: "Riverside Retail Partners", termDays: 30, revenueCategories: ["revenueService"], invoiceMin: 15000, invoiceMax: 220000, payment: { onTime: 0.35, late: 0.35, veryLate: 0.2, shortPay: 0.06, delinquent: 0.04 } },
    { name: "Northgate Industrial REIT", termDays: 45, revenueCategories: ["revenueService"], invoiceMin: 20000, invoiceMax: 350000, payment: { onTime: 0.45, late: 0.35, veryLate: 0.15, shortPay: 0.03, delinquent: 0.02 } },
    { name: "State DOT Region 4", termDays: 60, revenueCategories: ["revenueService"], invoiceMin: 40000, invoiceMax: 500000, payment: { onTime: 0.55, late: 0.3, veryLate: 0.1, shortPay: 0.03, delinquent: 0.02 } },
  ],
  cadence: {
    billsPerDay: 0.7,
    invoicesPerDay: 0, // fully bottom-up — all revenue comes from job billing
    expenseReportsPerDay: 0.3,
    journalPerDay: 0.2,
    payRunDayOfMonth: 20,
    closeDayOfMonth: 7,
  },
  expectedCapabilities: [
    "vendor_bill",
    "vendor_payment",
    "customer_invoice",
    "customer_payment",
    "period_close",
    "period_immutability",
    "construction_billing",
    "billable_time",
    "payroll_run",
    "expense_report",
    "expense_reimbursement",
  ],
};
