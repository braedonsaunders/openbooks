export interface SampleCompanyProfile {
  industryKey: string;
  profileId: string;
  companyName: string;
  focus: readonly string[];
}

/**
 * One product sample for every industry offered by first-run setup. Profile IDs
 * identify deterministic simulator definitions; company names and focus areas
 * are product metadata and must not be inferred from whichever database happens
 * to host a prepared template.
 */
export const SAMPLE_COMPANY_PROFILES = [
  {
    industryKey: "general_business",
    profileId: "general-business",
    companyName: "Cedar & Stone Supply Co.",
    focus: ["sales and purchasing", "cash flow", "month-end close"],
  },
  {
    industryKey: "construction_contractor",
    profileId: "general-contractor",
    companyName: "Summit Ridge Construction",
    focus: ["job costing", "field labor", "progress billing", "retainage"],
  },
  {
    industryKey: "professional_services",
    profileId: "professional-services",
    companyName: "Meridian Advisory Group",
    focus: ["engagements", "billable time", "utilization", "project margin"],
  },
  {
    industryKey: "engineering_architecture",
    profileId: "engineering-architecture",
    companyName: "Aperture Engineering Group",
    focus: ["projects", "professional time", "subconsultants", "project margin"],
  },
  {
    industryKey: "it_software_saas",
    profileId: "saas",
    companyName: "Northstar Cloud",
    focus: ["subscriptions", "deferred revenue", "revenue recognition", "dunning"],
  },
  {
    industryKey: "accounting_firm",
    profileId: "accounting-firm",
    companyName: "Ledgerline Advisory LLP",
    focus: ["engagements", "billable time", "work in progress", "client margin"],
  },
  {
    industryKey: "wholesale_distribution",
    profileId: "wholesale-distribution",
    companyName: "Harborline Distribution",
    focus: ["high-volume order flow", "purchasing", "gross margin", "working capital"],
  },
  {
    industryKey: "property_management",
    profileId: "property-management",
    companyName: "Hearthstone Property Management",
    focus: ["property portfolios", "service vendors", "management fees", "property margin"],
  },
  {
    industryKey: "nonprofit",
    profileId: "nonprofit",
    companyName: "BrightPath Community Foundation",
    focus: ["program activity", "grants and contributions", "spending", "stewardship reporting"],
  },
  {
    industryKey: "manufacturing",
    profileId: "manufacturing",
    companyName: "Atlas Components Manufacturing",
    focus: ["materials", "production economics", "gross margin", "working capital"],
  },
  {
    industryKey: "healthcare_practice",
    profileId: "healthcare-practice",
    companyName: "Northshore Family Health",
    focus: ["clinical services", "third-party payers", "supplies", "practice margin"],
  },
] as const satisfies readonly SampleCompanyProfile[];

export const SAMPLE_COMPANY_BY_INDUSTRY = new Map<string, (typeof SAMPLE_COMPANY_PROFILES)[number]>(
  SAMPLE_COMPANY_PROFILES.map((profile) => [profile.industryKey, profile]),
);

export const SAMPLE_COMPANY_BY_PROFILE = new Map<string, (typeof SAMPLE_COMPANY_PROFILES)[number]>(
  SAMPLE_COMPANY_PROFILES.map((profile) => [profile.profileId, profile]),
);
