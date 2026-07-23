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
  // A consulting firm: labor is the dominant cost (delivery consultants), leaving
  // a realistic ~20-25% net margin after overhead. `economics` is only the
  // fallback peg; with a workforce + engagements below, revenue runs FULLY
  // BOTTOM-UP (billed consultant time − labor cost − overhead).
  economics: { laborPctOfRevenue: "0.55", cogsPctOfRevenue: "0.06" },
  // Fully-loaded hourly cost and standard bill rate per consultant.
  workforce: [
    { name: "Dana Okafor (Managing Partner)", costRate: "165.00", billRate: "450.00" },
    { name: "Liam Chen (Principal)", costRate: "135.00", billRate: "375.00" },
    { name: "Ava Romano (Senior Manager)", costRate: "115.00", billRate: "325.00" },
    { name: "Noah Kline (Manager)", costRate: "98.00", billRate: "275.00" },
    { name: "Ivy Sarabia (Manager)", costRate: "96.00", billRate: "270.00" },
    { name: "Owen Frey (Consultant)", costRate: "78.00", billRate: "225.00" },
    { name: "Zoe Adeyemi (Consultant)", costRate: "76.00", billRate: "220.00" },
    { name: "Kai Watanabe (Analyst)", costRate: "62.00", billRate: "185.00" },
  ],
  engagementsPerCustomer: 2,
  utilization: 0.78,
  vendors: [
    { name: "WeWork Downtown", termDays: 30, expenseCategories: ["rent"], billMin: 8000, billMax: 12000 },
    { name: "Adobe Creative Cloud", termDays: 30, expenseCategories: ["office"], billMin: 600, billMax: 2400 },
    { name: "Regional Telecom", termDays: 21, expenseCategories: ["utilities"], billMin: 400, billMax: 1500 },
    { name: "Talent Contractors Inc", termDays: 30, expenseCategories: ["subcontractor"], billMin: 3000, billMax: 40000 },
    { name: "Beacon Professional Liability", termDays: 30, expenseCategories: ["insurance"], billMin: 900, billMax: 4000 },
    { name: "Sterling Accounting Partners", termDays: 30, expenseCategories: ["professionalFees"], billMin: 1500, billMax: 9000 },
    { name: "BrandForge Marketing", termDays: 30, expenseCategories: ["marketing"], billMin: 2000, billMax: 25000 },
    { name: "Corporate Travel Partners", termDays: 30, expenseCategories: ["travel", "meals"], billMin: 500, billMax: 14000 },
    { name: "First National Bank", termDays: 30, expenseCategories: ["bankFees", "interestExpense"], billMin: 200, billMax: 4500 },
    { name: "CloudStack Hosting", termDays: 30, expenseCategories: ["office"], billMin: 1500, billMax: 9000 },
  ],
  customers: [
    {
      name: "Northwind Retail Corp",
      termDays: 30,
      revenueCategories: ["revenueService", "revenueConsulting"],
      invoiceMin: 8000,
      invoiceMax: 60000,
      payment: { onTime: 0.6, late: 0.28, veryLate: 0.07, shortPay: 0.03, delinquent: 0.02 },
    },
    {
      name: "Bluewater Logistics",
      termDays: 30,
      revenueCategories: ["revenueService", "revenueConsulting"],
      invoiceMin: 12000,
      invoiceMax: 95000,
      payment: { onTime: 0.55, late: 0.3, veryLate: 0.1, shortPay: 0.03, delinquent: 0.02 },
    },
    {
      name: "Cardinal Health Systems",
      termDays: 45,
      revenueCategories: ["revenueService", "revenueConsulting"],
      invoiceMin: 20000,
      invoiceMax: 180000,
      payment: { onTime: 0.5, late: 0.32, veryLate: 0.12, shortPay: 0.04, delinquent: 0.02 },
    },
    {
      name: "Evergreen Startups Ltd",
      termDays: 15,
      revenueCategories: ["revenueService", "revenueConsulting"],
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
    "journal",
    "period_close",
    "period_immutability",
  ],
};
