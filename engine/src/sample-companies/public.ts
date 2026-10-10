/** Setup and maintenance contract for isolated industry demonstrations. */
export {
  SampleCompanyError,
  SampleCompanyProvisioningError,
  createSampleCompany,
  prepareIndustryDemo,
  prepareAllSampleCompanyTemplates,
  sampleCompanyProvisioningBody,
  sampleCompanyStatuses,
} from "./service.ts";
export type { CreateSampleCompanyInput, CreateSampleCompanyResult, PrepareSampleCompanyResult, SampleCompanyStatus } from "./service.ts";
export { sampleCompanyFeatures } from "./features.ts";
export { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";

export { sampleRefreshPlan, refreshSampleCompany, refreshAllSampleCompanies } from "./refresh.ts";
