import type { Profile } from "./types.ts";

/**
 * A professional-services firm (agency / consultancy). Lower cost intensity,
 * high invoice frequency, mostly labour + overhead, customers that pay closer
 * to terms. A contrast to the contractor: small bills, many invoices.
 */
export const professionalServices: Profile = {
  id: "professional-services",
  name: "Meridian Advisory Group",
  industry: "professional_services",
  baseCurrency: "USD",
  country: "US",
  vendors: [
    { name: "WeWork Downtown", termDays: 30, expenseCategories: ["rent"], billMin: 8000, billMax: 12000 },
    { name: "Adobe Creative Cloud", termDays: 30, expenseCategories: ["office"], billMin: 600, billMax: 2400 },
    { name: "Regional Telecom", termDays: 21, expenseCategories: ["utilities"], billMin: 400, billMax: 1500 },
    { name: "Talent Contractors Inc", termDays: 30, expenseCategories: ["subcontractor"], billMin: 3000, billMax: 40000 },
    { name: "Beacon Professional Liability", termDays: 30, expenseCategories: ["insurance"], billMin: 900, billMax: 4000 },
    { name: "Sterling Accounting Partners", termDays: 30, expenseCategories: ["professionalFees"], billMin: 1500, billMax: 9000 },
  ],
  customers: [
    {
      name: "Northwind Retail Corp",
      termDays: 30,
      revenueCategories: ["revenueService"],
      invoiceMin: 8000,
      invoiceMax: 60000,
      payment: { onTime: 0.6, late: 0.28, veryLate: 0.07, shortPay: 0.03, delinquent: 0.02 },
    },
    {
      name: "Bluewater Logistics",
      termDays: 30,
      revenueCategories: ["revenueService"],
      invoiceMin: 12000,
      invoiceMax: 95000,
      payment: { onTime: 0.55, late: 0.3, veryLate: 0.1, shortPay: 0.03, delinquent: 0.02 },
    },
    {
      name: "Cardinal Health Systems",
      termDays: 45,
      revenueCategories: ["revenueService"],
      invoiceMin: 20000,
      invoiceMax: 180000,
      payment: { onTime: 0.5, late: 0.32, veryLate: 0.12, shortPay: 0.04, delinquent: 0.02 },
    },
    {
      name: "Evergreen Startups Ltd",
      termDays: 15,
      revenueCategories: ["revenueService"],
      invoiceMin: 3000,
      invoiceMax: 30000,
      payment: { onTime: 0.4, late: 0.35, veryLate: 0.15, shortPay: 0.06, delinquent: 0.04 },
    },
  ],
  cadence: {
    billsPerDay: 1.2,
    invoicesPerDay: 1.8,
    expenseReportsPerDay: 0.8,
    journalPerDay: 0.25,
    payRunDayOfMonth: 25,
    closeDayOfMonth: 5,
  },
  expectedCapabilities: [
    "vendor_bill",
    "vendor_payment",
    "customer_invoice",
    "customer_credit",
    "customer_payment",
    "expense_report",
    "journal",
    "period_close",
    "period_immutability",
  ],
};
