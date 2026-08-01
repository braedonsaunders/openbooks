import { professionalServices } from "./professional-services.ts";
import type { CustomerSpec, Profile, VendorSpec } from "./types.ts";

const steadyPayment = {
  onTime: 0.58,
  late: 0.27,
  veryLate: 0.09,
  shortPay: 0.04,
  delinquent: 0.02,
} as const;

const expectedCore = [
  "vendor_bill",
  "vendor_payment",
  "customer_invoice",
  "customer_payment",
  "period_close",
  "period_immutability",
];

function customers(
  names: string[],
  revenueCategories: string[],
  range: [number, number],
  termDays = 30,
): CustomerSpec[] {
  return names.map((name, index) => ({
    name,
    termDays: index === names.length - 1 ? Math.max(termDays, 45) : termDays,
    revenueCategories,
    invoiceMin: range[0],
    invoiceMax: range[1],
    payment: { ...steadyPayment },
  }));
}

function vendors(
  rows: Array<[name: string, expenseCategories: string[], minimum: number, maximum: number, termDays?: number]>,
): VendorSpec[] {
  return rows.map(([name, expenseCategories, billMin, billMax, termDays = 30]) => ({
    name,
    termDays,
    expenseCategories,
    billMin,
    billMax,
  }));
}

function serviceProfile(input: {
  id: string;
  name: string;
  industry: string;
  customers: CustomerSpec[];
  vendors: VendorSpec[];
  workforce: Profile["workforce"];
  economics?: NonNullable<Profile["economics"]>;
  utilization?: number;
}): Profile {
  return {
    ...professionalServices,
    id: input.id,
    name: input.name,
    industry: input.industry,
    customers: input.customers,
    vendors: input.vendors,
    workforce: input.workforce,
    economics: input.economics ?? { laborPctOfRevenue: "0.52", cogsPctOfRevenue: "0.07" },
    utilization: input.utilization ?? 0.74,
    engagementsPerCustomer: 2,
    cadence: {
      billsPerDay: 0.45,
      invoicesPerDay: 1.25,
      expenseReportsPerDay: 0.45,
      journalPerDay: 0.15,
      payRunDayOfMonth: 25,
      closeDayOfMonth: 5,
    },
    expectedCapabilities: [...expectedCore],
  };
}

function tradeProfile(input: {
  id: string;
  name: string;
  industry: string;
  customers: CustomerSpec[];
  vendors: VendorSpec[];
  economics: NonNullable<Profile["economics"]>;
  activity?: "steady" | "high";
}): Profile {
  const high = input.activity === "high";
  return {
    ...professionalServices,
    id: input.id,
    name: input.name,
    industry: input.industry,
    customers: input.customers,
    vendors: input.vendors,
    workforce: undefined,
    engagementsPerCustomer: 0,
    utilization: undefined,
    economics: input.economics,
    cadence: {
      billsPerDay: high ? 1.6 : 0.8,
      invoicesPerDay: high ? 2.4 : 1.25,
      expenseReportsPerDay: 0.25,
      journalPerDay: 0.15,
      payRunDayOfMonth: 25,
      closeDayOfMonth: 5,
    },
    expectedCapabilities: [...expectedCore],
  };
}

export const generalBusiness = tradeProfile({
  id: "general-business",
  name: "Cedar & Stone Supply Co.",
  industry: "general_business",
  economics: { laborPctOfRevenue: "0.24", cogsPctOfRevenue: "0.48" },
  customers: customers(
    ["Oak & Main Market", "Westfield Hospitality", "Juniper Home Group", "Parkside Retail Cooperative"],
    ["revenueProduct", "revenueService"],
    [2_500, 38_000],
  ),
  vendors: vendors([
    ["Evergreen Goods Ltd.", ["materials"], 3_000, 42_000],
    ["Prairie Freight Services", ["materials"], 900, 8_500],
    ["Central Commercial Properties", ["rent"], 7_500, 7_500],
    ["Beacon Business Insurance", ["insurance"], 1_100, 4_500],
    ["OfficeHub Systems", ["office"], 500, 3_500],
    ["Mercantile Bank", ["bankFees", "interestExpense"], 150, 2_500],
  ]),
});
export const engineeringArchitecture = serviceProfile({
  id: "engineering-architecture",
  name: "Aperture Engineering Group",
  industry: "engineering_architecture",
  customers: customers(
    ["City of Redbrook", "Helios Developments", "Northline Transit Authority", "Granite Civic Partners"],
    ["revenueConsulting", "revenueService"],
    [18_000, 185_000],
    45,
  ),
  workforce: [
    { name: "Elena Park (Principal Engineer)", costRate: "142.00", billRate: "365.00" },
    { name: "Marcus Reed (Project Architect)", costRate: "118.00", billRate: "305.00" },
    { name: "Sofia Haddad (Structural Engineer)", costRate: "102.00", billRate: "270.00" },
    { name: "Theo Martin (Civil Designer)", costRate: "78.00", billRate: "205.00" },
    { name: "Priya Desai (BIM Specialist)", costRate: "72.00", billRate: "190.00" },
  ],
  vendors: vendors([
    ["GeoLab Testing Services", ["subcontractor"], 4_000, 45_000],
    ["Autodesk", ["office"], 1_200, 9_500],
    ["Precision Survey Group", ["subcontractor"], 5_000, 55_000],
    ["Studio Property Partners", ["rent"], 12_000, 12_000],
    ["Professional Risk Underwriters", ["insurance"], 2_000, 12_000],
  ]),
});

export const accountingFirm = serviceProfile({
  id: "accounting-firm",
  name: "Ledgerline Advisory LLP",
  industry: "accounting_firm",
  customers: customers(
    ["Aster Foods Inc.", "Beacon Robotics", "Copperfield Family Office", "Riverbend Manufacturing"],
    ["revenueService", "revenueConsulting"],
    [4_500, 72_000],
  ),
  workforce: [
    { name: "Maya Chen (Partner)", costRate: "155.00", billRate: "430.00" },
    { name: "Gabriel Foster (Tax Director)", costRate: "128.00", billRate: "355.00" },
    { name: "Nadia Singh (Audit Manager)", costRate: "105.00", billRate: "295.00" },
    { name: "Connor Bell (Senior Accountant)", costRate: "76.00", billRate: "215.00" },
    { name: "Amara Wilson (Staff Accountant)", costRate: "54.00", billRate: "155.00" },
  ],
  vendors: vendors([
    ["Thomson Reuters Tax", ["office"], 1_500, 8_000],
    ["Caseware Cloud", ["office"], 1_200, 6_500],
    ["Downtown Professional Centre", ["rent"], 10_000, 10_000],
    ["SecureDocs Canada", ["office"], 500, 3_000],
    ["CPA Professional Insurance", ["insurance"], 1_000, 6_000],
  ]),
});

export const wholesaleDistribution = tradeProfile({
  id: "wholesale-distribution",
  name: "Harborline Distribution",
  industry: "wholesale_distribution",
  activity: "high",
  economics: { laborPctOfRevenue: "0.13", cogsPctOfRevenue: "0.67" },
  customers: customers(
    ["Metro Hardware Group", "Summit Restaurant Supply", "Northern Retail Alliance", "Beacon Industrial Stores"],
    ["revenueProduct"],
    [8_000, 145_000],
  ),
  vendors: vendors([
    ["Pacific Housewares Manufacturing", ["materials"], 18_000, 210_000],
    ["Atlas Industrial Products", ["materials"], 12_000, 165_000],
    ["Portside Freight & Customs", ["materials"], 4_000, 32_000],
    ["CrossDock Warehousing", ["rent", "equipmentRental"], 15_000, 28_000],
    ["Fleetway Transport", ["equipmentRental"], 6_000, 45_000],
  ]),
});

export const propertyManagement = serviceProfile({
  id: "property-management",
  name: "Hearthstone Property Management",
  industry: "property_management",
  economics: { laborPctOfRevenue: "0.34", cogsPctOfRevenue: "0.26" },
  customers: customers(
    ["Maple Court Residences", "Lakeshore Commercial LP", "Parkview Condominium Corp.", "Westgate Apartments"],
    ["revenueService"],
    [9_000, 68_000],
  ),
  workforce: [
    { name: "Renee Walsh (Portfolio Manager)", costRate: "72.00", billRate: "165.00" },
    { name: "Omar Khalil (Property Manager)", costRate: "58.00", billRate: "135.00" },
    { name: "Grace Liu (Leasing Manager)", costRate: "52.00", billRate: "125.00" },
    { name: "Derek Cole (Building Coordinator)", costRate: "44.00", billRate: "105.00" },
  ],
  vendors: vendors([
    ["Reliable Mechanical Services", ["subcontractor"], 2_000, 35_000],
    ["EverClean Janitorial", ["subcontractor"], 3_000, 14_000],
    ["Guardian Security", ["subcontractor"], 1_500, 9_000],
    ["City Utilities", ["utilities"], 4_000, 28_000],
    ["Groundswell Landscaping", ["subcontractor"], 1_500, 12_000],
  ]),
});

export const nonprofit = tradeProfile({
  id: "nonprofit",
  name: "BrightPath Community Foundation",
  industry: "nonprofit",
  economics: { laborPctOfRevenue: "0.41", cogsPctOfRevenue: "0.32" },
  customers: customers(
    ["Community Services Grant", "Northstar Family Fund", "City Youth Initiative", "Evergreen Corporate Giving"],
    ["revenueService", "otherIncome"],
    [12_000, 160_000],
    45,
  ),
  vendors: vendors([
    ["Community Food Network", ["materials"], 5_000, 45_000],
    ["Youth Program Facilitators", ["subcontractor"], 4_000, 38_000],
    ["Civic Centre Rentals", ["rent"], 2_000, 14_000],
    ["Volunteer Screening Services", ["professionalFees"], 500, 4_000],
    ["Community Outreach Media", ["marketing"], 1_000, 12_000],
  ]),
});

export const manufacturing = tradeProfile({
  id: "manufacturing",
  name: "Atlas Components Manufacturing",
  industry: "manufacturing",
  activity: "high",
  economics: { laborPctOfRevenue: "0.22", cogsPctOfRevenue: "0.54" },
  customers: customers(
    ["Orion Mobility", "Vertex Automation", "Crescent Appliance Group", "Northstar Equipment"],
    ["revenueProduct"],
    [22_000, 240_000],
    45,
  ),
  vendors: vendors([
    ["Continental Metals", ["materials"], 25_000, 260_000],
    ["Precision Plastics", ["materials"], 12_000, 130_000],
    ["Industrial Controls Supply", ["materials"], 8_000, 85_000],
    ["Plant Equipment Leasing", ["equipmentRental"], 9_000, 42_000],
    ["FreightRail Logistics", ["materials"], 5_000, 38_000],
  ]),
});

export const healthcarePractice = serviceProfile({
  id: "healthcare-practice",
  name: "Northshore Family Health",
  industry: "healthcare_practice",
  economics: { laborPctOfRevenue: "0.49", cogsPctOfRevenue: "0.16" },
  utilization: 0.68,
  customers: customers(
    ["Provincial Health Plan", "Evergreen Benefits", "Northstar Insurance", "Patient Services"],
    ["revenueService"],
    [6_000, 95_000],
    45,
  ),
  workforce: [
    { name: "Dr. Maya Patel (Physician)", costRate: "168.00", billRate: "390.00" },
    { name: "Dr. Owen Brooks (Physician)", costRate: "158.00", billRate: "370.00" },
    { name: "Leah Morgan (Nurse Practitioner)", costRate: "82.00", billRate: "195.00" },
    { name: "Samuel Kim (Registered Nurse)", costRate: "58.00", billRate: "135.00" },
    { name: "Ines Alvarez (Clinic Coordinator)", costRate: "39.00", billRate: "92.00" },
  ],
  vendors: vendors([
    ["Medline Clinical Supplies", ["materials"], 4_000, 28_000],
    ["LifeLabs Diagnostics", ["subcontractor"], 3_000, 32_000],
    ["Clinic Property Partners", ["rent"], 14_000, 14_000],
    ["Health Records Cloud", ["office"], 1_500, 7_000],
    ["Medical Liability Association", ["insurance"], 2_500, 15_000],
  ]),
});
