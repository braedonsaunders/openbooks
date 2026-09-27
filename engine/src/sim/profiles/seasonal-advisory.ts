import { accountingFirm } from "./industry-samples.ts";
import type { Profile } from "./types.ts";

const steady = {
  1: "1.00", 2: "1.00", 3: "1.00", 4: "1.00", 5: "1.00", 6: "1.00",
  7: "1.00", 8: "1.00", 9: "1.00", 10: "1.00", 11: "1.00", 12: "1.00",
} as const;

const assuranceDemand = {
  ...steady,
  1: "1.45", 2: "1.45", 3: "1.45", 4: "1.35",
} as const;

const taxDemand = {
  ...steady,
  1: "1.65", 2: "1.65", 3: "1.55", 4: "1.40", 9: "1.35", 10: "1.35",
} as const;

export const seasonalAdvisory: Profile = {
  ...accountingFirm,
  id: "seasonal-advisory",
  name: "Summit Ledger & Advisory",
  industry: "accounting_firm",
  utilization: 0.78,
  engagementsPerCustomer: 2,
  workforce: [
    { name: "Maya Chen (Assurance Partner)", costRate: "155.00", billRate: "430.00" },
    { name: "Gabriel Foster (Assurance Manager)", costRate: "128.00", billRate: "355.00" },
    { name: "Nadia Singh (Senior Auditor)", costRate: "105.00", billRate: "295.00" },
    { name: "Connor Bell (Senior Auditor)", costRate: "76.00", billRate: "215.00" },
    { name: "Amara Wilson (Tax Director)", costRate: "155.00", billRate: "430.00" },
    { name: "Ethan Brooks (Tax Manager)", costRate: "128.00", billRate: "355.00" },
    { name: "Priya Desai (Senior Tax Associate)", costRate: "76.00", billRate: "215.00" },
    { name: "Lucas Bennett (Tax Associate)", costRate: "54.00", billRate: "155.00" },
    { name: "Sofia Haddad (Advisory Partner)", costRate: "155.00", billRate: "430.00" },
    { name: "Theo Martin (Advisory Director)", costRate: "128.00", billRate: "355.00" },
    { name: "Elena Park (Senior Consultant)", costRate: "98.00", billRate: "275.00" },
    { name: "Marcus Reed (Analyst)", costRate: "62.00", billRate: "185.00" },
  ],
  resourcing: {
    softBookingShare: "0.18",
    practices: [
      {
        name: "Assurance",
        positions: [
          { jobTitle: "Assurance Partner", members: ["Maya Chen (Assurance Partner)"] },
          { jobTitle: "Assurance Manager", members: ["Gabriel Foster (Assurance Manager)"] },
          { jobTitle: "Senior Auditor", members: ["Nadia Singh (Senior Auditor)", "Connor Bell (Senior Auditor)"] },
        ],
        monthlyDemandFactors: assuranceDemand,
        genericDemand: { jobTitle: "Senior Auditor" },
      },
      {
        name: "Tax",
        positions: [
          { jobTitle: "Tax Director", members: ["Amara Wilson (Tax Director)"] },
          { jobTitle: "Tax Manager", members: ["Ethan Brooks (Tax Manager)"] },
          { jobTitle: "Senior Tax Associate", members: ["Priya Desai (Senior Tax Associate)"] },
          { jobTitle: "Tax Associate", members: ["Lucas Bennett (Tax Associate)"] },
        ],
        monthlyDemandFactors: taxDemand,
        genericDemand: { jobTitle: "Senior Tax Associate" },
      },
      {
        name: "Advisory",
        positions: [
          { jobTitle: "Advisory Partner", members: ["Sofia Haddad (Advisory Partner)"] },
          { jobTitle: "Advisory Director", members: ["Theo Martin (Advisory Director)"] },
          { jobTitle: "Senior Consultant", members: ["Elena Park (Senior Consultant)"] },
          { jobTitle: "Analyst", members: ["Marcus Reed (Analyst)"] },
        ],
        monthlyDemandFactors: steady,
      },
    ],
  },
};
