import type { CoaEntry, PlanSpec, Profile, SubscriberSpec } from "./types.ts";

/**
 * A B2B SaaS company running on RECURRING subscription revenue — the polar
 * opposite of the contractor. Revenue is not invoiced per job; it's billed on a
 * cycle by the recurring-billing engine, parked in DEFERRED REVENUE on posting,
 * and drained to earned revenue ratably by the revenue-recognition engine. Annual
 * plans are billed up front and recognized over twelve months (the classic
 * deferred-revenue liability); monthly plans recognize in-month. On top of the
 * base MRR ride expansion (seat upgrades → prorated), churn (cancellations),
 * dunning on failed collections, and usage overages. The cost base is a software
 * company's: hosting/infrastructure + a big R&D and S&M payroll, near-zero COGS
 * of goods. This exercises a completely different swath of the product than the
 * contractor: subscriptions, deferred revenue, ratable recognition, and dunning.
 */
const SAAS_COA: CoaEntry[] = [
  // ---- Assets ----
  ["bank", "1000", "Operating Cash", "asset_bank"],
  ["bankSavings", "1020", "Reserve Savings", "asset_bank"],
  ["ar", "1100", "Accounts Receivable", "asset_receivable"],
  ["allowanceDoubtful", "1190", "Allowance for Doubtful Accounts", "asset_current_other"],
  ["prepaid", "1200", "Prepaid Expenses", "asset_current_other"],
  ["prepaidInsurance", "1210", "Prepaid Insurance", "asset_current_other"],
  ["prepaidHosting", "1220", "Prepaid Hosting & Software", "asset_current_other"],
  ["inventory", "1300", "Inventory (Devices)", "asset_current_other"],
  ["unbilledRevenue", "1310", "Unbilled / Contract Asset", "asset_current_other"],
  ["deposits", "1450", "Security Deposits", "asset_other"],
  ["equipment", "1500", "Computers & Equipment", "asset_fixed"],
  ["vehicles", "1510", "Vehicles", "asset_fixed"],
  ["furniture", "1520", "Furniture & Fixtures", "asset_fixed"],
  ["leasehold", "1530", "Leasehold Improvements", "asset_fixed"],
  ["capSoftware", "1550", "Capitalized Software", "asset_fixed"],
  ["accumDep", "1590", "Accumulated Depreciation", "asset_fixed"],
  // ---- Liabilities ----
  ["ap", "2000", "Accounts Payable", "liability_payable"],
  ["creditCard", "2050", "Corporate Credit Card", "liability_card"],
  ["accrued", "2100", "Accrued Liabilities", "liability_current_other"],
  ["employeePayable", "2110", "Employee Reimbursements Payable", "liability_current_other"],
  ["accruedPayroll", "2120", "Accrued Payroll", "liability_current_other"],
  ["deferredRevenue", "2200", "Deferred Revenue", "liability_current_other"],
  ["taxOutput", "2250", "Sales Tax Payable", "liability_current_other"],
  ["payrollTaxPayable", "2260", "Payroll Taxes Payable", "liability_current_other"],
  ["currentDebt", "2400", "Current Portion of Long-Term Debt", "liability_current_other"],
  ["lineOfCredit", "2700", "Venture Debt / Line of Credit", "liability_long_term"],
  ["notesPayable", "2800", "Notes Payable", "liability_long_term"],
  // ---- Equity ----
  ["commonStock", "3000", "Common Stock", "equity"],
  ["apic", "3100", "Additional Paid-In Capital (Preferred)", "equity"],
  ["retainedEarnings", "3200", "Accumulated Deficit", "equity"],
  ["distributions", "3300", "Distributions", "equity"],
  ["openingBalanceEquity", "3900", "Opening Balance Equity", "equity"],
  // ---- Income ----
  ["subscriptionRevenue", "4000", "Subscription Revenue (recognized)", "income"],
  ["revenueService", "4001", "Subscription Revenue — Other", "income"],
  ["usageRevenue", "4010", "Usage & Overage Revenue", "income"],
  ["servicesRevenue", "4020", "Onboarding & Professional Services", "income"],
  ["revenueProduct", "4030", "Device / Hardware Revenue", "income"],
  ["otherIncome", "4900", "Other Income", "income_other"],
  ["interestIncome", "4910", "Interest Income", "income_other"],
  // ---- COGS ----
  ["cogs", "5000", "Cost of Revenue — Other", "cogs"],
  ["hostingCogs", "5100", "Hosting & Infrastructure", "cogs"],
  ["supportCogs", "5200", "Customer Support & Success", "cogs"],
  ["paymentProcessing", "5300", "Payment Processing Fees", "cogs"],
  ["materials", "5400", "Third-Party Software (COGS)", "cogs"],
  // ---- Operating expenses ----
  ["payroll", "6000", "Salaries & Wages", "expense"],
  ["rdExpense", "6050", "Research & Development", "expense"],
  ["smExpense", "6060", "Sales & Marketing", "expense"],
  ["gaExpense", "6070", "General & Administrative", "expense"],
  ["benefits", "6010", "Employee Benefits", "expense"],
  ["payrollTaxExpense", "6020", "Payroll Tax Expense", "expense"],
  ["rent", "6100", "Rent", "expense"],
  ["utilities", "6200", "Utilities & Telecom", "expense"],
  ["insurance", "6300", "Insurance", "expense"],
  ["office", "6400", "Software & IT", "expense"],
  ["professionalFees", "6500", "Professional Fees", "expense"],
  ["marketing", "6550", "Marketing & Advertising", "expense"],
  ["badDebt", "6600", "Bad Debt Expense", "expense"],
  ["travel", "6650", "Travel", "expense"],
  ["meals", "6660", "Meals & Entertainment", "expense"],
  ["depreciation", "6700", "Depreciation & Amortization", "expense"],
  ["bankFees", "6800", "Bank & Merchant Fees", "expense"],
  ["miscExpense", "6900", "Miscellaneous Expense", "expense_other"],
  ["interestExpense", "6950", "Interest Expense", "expense_other"],
];

// `amount` is the PER-SEAT price (subscription quantity = seats). Annual plans are
// priced ~2 months free vs monthly.
const PLANS: PlanSpec[] = [
  { key: "starter_m", name: "Starter (Monthly)", amount: 29, interval: "monthly", termMonths: 1 },
  { key: "growth_m", name: "Growth (Monthly)", amount: 99, interval: "monthly", termMonths: 1 },
  { key: "scale_m", name: "Scale (Monthly)", amount: 299, interval: "monthly", termMonths: 1 },
  { key: "growth_a", name: "Growth (Annual)", amount: 990, interval: "annually", termMonths: 12 },
  { key: "scale_a", name: "Scale (Annual)", amount: 2990, interval: "annually", termMonths: 12 },
  { key: "enterprise_a", name: "Enterprise (Annual)", amount: 4500, interval: "annually", termMonths: 12 },
];

// A subscriber base across plans; quantity = seats. Annual enterprise deals create
// the large up-front deferred-revenue balances that recognition drains over the year.
const SUBSCRIBERS: SubscriberSpec[] = [
  { customer: "Rivera Dental Group", plan: "starter_m", quantity: 3 },
  { customer: "Kettle & Co Roasters", plan: "starter_m", quantity: 2 },
  { customer: "Brightpath Tutoring", plan: "starter_m", quantity: 5 },
  { customer: "Nomad Gear Outfitters", plan: "growth_m", quantity: 8 },
  { customer: "Harbor Freight Logistics", plan: "growth_m", quantity: 12 },
  { customer: "Summit Physical Therapy", plan: "growth_m", quantity: 6 },
  { customer: "Lumen Media Agency", plan: "scale_m", quantity: 20 },
  { customer: "Vertex Manufacturing", plan: "scale_m", quantity: 35 },
  { customer: "Cobalt Fintech", plan: "growth_a", quantity: 15 },
  { customer: "Meridian Health Network", plan: "scale_a", quantity: 60 },
  { customer: "Atlas Retail Group", plan: "scale_a", quantity: 45 },
  { customer: "Orion Aerospace", plan: "enterprise_a", quantity: 120 },
  { customer: "Continental Bank Corp", plan: "enterprise_a", quantity: 200 },
];

export const saasCompany: Profile = {
  id: "saas",
  name: "Northstar Cloud",
  industry: "saas",
  baseCurrency: "USD",
  country: "US",
  coa: SAAS_COA,
  openingScale: 2.0,
  subscriptionPlans: PLANS,
  subscribers: SUBSCRIBERS,
  usageBillingRate: 0.25,
  // Payroll (R&D + S&M + G&A) is a software company's dominant cost and is FIXED
  // monthly (not revenue-pegged) — the SaaS driver books it at month-end so annual
  // up-front billings don't distort the burn.
  saasMonthlyPayroll: 640000,
  vendors: [
    { name: "AWS", termDays: 30, expenseCategories: ["hostingCogs"], billMin: 18000, billMax: 60000 },
    { name: "Datadog Observability", termDays: 30, expenseCategories: ["hostingCogs"], billMin: 3000, billMax: 12000 },
    { name: "Stripe (processing)", termDays: 15, expenseCategories: ["paymentProcessing"], billMin: 4000, billMax: 22000 },
    { name: "Zendesk Support", termDays: 30, expenseCategories: ["supportCogs"], billMin: 2000, billMax: 8000 },
    { name: "Google Workspace & SaaS tools", termDays: 30, expenseCategories: ["office"], billMin: 3000, billMax: 14000 },
    { name: "Demand-Gen Marketing", termDays: 30, expenseCategories: ["marketing"], billMin: 15000, billMax: 90000 },
    { name: "WeWork HQ", termDays: 30, expenseCategories: ["rent"], billMin: 22000, billMax: 22000 },
    { name: "Gusto Benefits", termDays: 30, expenseCategories: ["benefits"], billMin: 12000, billMax: 40000 },
    { name: "Fenwick Legal", termDays: 30, expenseCategories: ["professionalFees"], billMin: 4000, billMax: 30000 },
    { name: "Corporate Travel", termDays: 30, expenseCategories: ["travel", "meals"], billMin: 1500, billMax: 20000 },
  ],
  // Subscribers are the revenue source; these customer records back the
  // subscriptions (and take usage-overage + services invoices). No per-day
  // random invoicing — revenue is 100% recurring.
  customers: [
    "Rivera Dental Group", "Kettle & Co Roasters", "Brightpath Tutoring", "Nomad Gear Outfitters",
    "Harbor Freight Logistics", "Summit Physical Therapy", "Lumen Media Agency", "Vertex Manufacturing",
    "Cobalt Fintech", "Meridian Health Network", "Atlas Retail Group", "Orion Aerospace", "Continental Bank Corp",
  ].map((name) => ({
    name,
    termDays: 30,
    revenueCategories: ["usageRevenue"],
    invoiceMin: 200,
    invoiceMax: 4000,
    payment: { onTime: 0.7, late: 0.2, veryLate: 0.06, shortPay: 0.02, delinquent: 0.02 },
  })),
  cadence: {
    billsPerDay: 0.8,
    invoicesPerDay: 0, // 100% recurring — no random invoicing
    expenseReportsPerDay: 0.3,
    journalPerDay: 0.2,
    payRunDayOfMonth: 25,
    closeDayOfMonth: 6,
  },
  expectedCapabilities: [
    "vendor_bill",
    "vendor_payment",
    "customer_invoice",
    "customer_payment",
    "period_close",
    "period_immutability",
    "subscription_billing",
    "revenue_recognition",
    "dunning",
    "subscription_change",
  ],
};
