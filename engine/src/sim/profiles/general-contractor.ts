import type { CoaEntry, Profile } from "./types.ts";

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
  ["otherIncome", "4900", "Other Income", "income_other"],
  ["interestIncome", "4910", "Interest Income", "income_other"],
  // Job costs (COGS)
  ["cogs", "5000", "Job Cost — Other", "cogs"],
  ["materials", "5100", "Job Cost — Materials", "cogs"],
  ["subcontractor", "5200", "Job Cost — Subcontractors", "cogs"],
  ["directLabor", "5300", "Job Cost — Payroll Labor", "cogs"],
  ["laborWip", "5350", "Job Cost — Field Labor (T&M crews)", "cogs"],
  ["equipmentRental", "5400", "Job Cost — Equipment", "cogs"],
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
 * A mid-size general contractor. Materials + subcontractor heavy on the cost
 * side, progress-billed revenue on the income side, customers that pay slowly
 * (construction is famously long-DSO), and a monthly close a week into the next
 * month. The deepest vertical — later phases add AIA pay applications, field
 * tickets, equipment and retainage on top of this base.
 */
export const generalContractor: Profile = {
  id: "general-contractor",
  name: "Summit Ridge Construction",
  industry: "construction",
  baseCurrency: "USD",
  country: "US",
  coa: CONSTRUCTION_COA,
  openingScale: 2.5,
  vendors: [
    { name: "Cascade Building Supply", termDays: 30, expenseCategories: ["materials"], billMin: 800, billMax: 45000 },
    { name: "Ironclad Steel & Rebar", termDays: 45, expenseCategories: ["materials"], billMin: 2000, billMax: 80000 },
    { name: "Delta Electrical Subs", termDays: 30, expenseCategories: ["subcontractor"], billMin: 5000, billMax: 120000 },
    { name: "Peak Plumbing Contractors", termDays: 30, expenseCategories: ["subcontractor"], billMin: 4000, billMax: 90000 },
    { name: "Metro Equipment Rental", termDays: 15, expenseCategories: ["materials"], billMin: 500, billMax: 12000 },
    { name: "Statewide Insurance", termDays: 30, expenseCategories: ["insurance"], billMin: 1200, billMax: 6000 },
    { name: "City Utilities", termDays: 21, expenseCategories: ["utilities"], billMin: 300, billMax: 2500 },
    { name: "Anderson Legal & Bonding", termDays: 30, expenseCategories: ["professionalFees"], billMin: 800, billMax: 15000 },
    { name: "United Equipment Rental", termDays: 30, expenseCategories: ["equipmentRental"], billMin: 1500, billMax: 35000 },
    { name: "TradeForce Labor Brokers", termDays: 15, expenseCategories: ["directLabor"], billMin: 8000, billMax: 90000 },
    { name: "Summit Payroll Co", termDays: 15, expenseCategories: ["payroll", "benefits", "payrollTaxExpense"], billMin: 40000, billMax: 140000 },
    { name: "Fleet Fuel & Maintenance", termDays: 30, expenseCategories: ["equipmentRental", "travel"], billMin: 800, billMax: 9000 },
  ],
  customers: [
    {
      name: "Harborview Development LLC",
      termDays: 45,
      revenueCategories: ["revenueService"],
      invoiceMin: 25000,
      invoiceMax: 400000,
      payment: { onTime: 0.3, late: 0.4, veryLate: 0.2, shortPay: 0.07, delinquent: 0.03 },
    },
    {
      name: "Municipal School District #7",
      termDays: 60,
      revenueCategories: ["revenueService"],
      invoiceMin: 50000,
      invoiceMax: 650000,
      payment: { onTime: 0.5, late: 0.35, veryLate: 0.1, shortPay: 0.03, delinquent: 0.02 },
    },
    {
      name: "Riverside Retail Partners",
      termDays: 30,
      revenueCategories: ["revenueService", "revenueProduct"],
      invoiceMin: 15000,
      invoiceMax: 220000,
      payment: { onTime: 0.35, late: 0.35, veryLate: 0.2, shortPay: 0.06, delinquent: 0.04 },
    },
  ],
  cadence: {
    billsPerDay: 3.5,
    invoicesPerDay: 0.6,
    expenseReportsPerDay: 0.4,
    journalPerDay: 0.3,
    payRunDayOfMonth: 20,
    closeDayOfMonth: 7,
  },
  expectedCapabilities: [
    "vendor_bill",
    "vendor_credit",
    "vendor_payment",
    "customer_invoice",
    "customer_credit",
    "customer_payment",
    "journal",
    "period_close",
    "period_immutability",
  ],
};
