import type { Profile } from "./types.ts";

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
  vendors: [
    { name: "Cascade Building Supply", termDays: 30, expenseCategories: ["materials"], billMin: 800, billMax: 45000 },
    { name: "Ironclad Steel & Rebar", termDays: 45, expenseCategories: ["materials"], billMin: 2000, billMax: 80000 },
    { name: "Delta Electrical Subs", termDays: 30, expenseCategories: ["subcontractor"], billMin: 5000, billMax: 120000 },
    { name: "Peak Plumbing Contractors", termDays: 30, expenseCategories: ["subcontractor"], billMin: 4000, billMax: 90000 },
    { name: "Metro Equipment Rental", termDays: 15, expenseCategories: ["materials"], billMin: 500, billMax: 12000 },
    { name: "Statewide Insurance", termDays: 30, expenseCategories: ["insurance"], billMin: 1200, billMax: 6000 },
    { name: "City Utilities", termDays: 21, expenseCategories: ["utilities"], billMin: 300, billMax: 2500 },
    { name: "Anderson Legal & Bonding", termDays: 30, expenseCategories: ["professionalFees"], billMin: 800, billMax: 15000 },
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
