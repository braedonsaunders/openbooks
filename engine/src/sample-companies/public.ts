/** Setup and maintenance contract for isolated industry demonstrations. */
export {
  SampleCompanyError,
  SampleCompanyProvisioningError,
  assertSampleRequestAccess,
  createSampleCompany,
  readySampleCompany,
  prepareIndustryDemo,
  prepareAllSampleCompanyTemplates,
  sampleCompanyProvisioningBody,
  sampleCompanyStatuses,
} from "./service.ts";
export type {
  CreateSampleCompanyInput,
  CreateSampleCompanyResult,
  PrepareSampleCompanyResult,
  SampleCompanyStatus,
} from "./service.ts";
export { sampleCompanyFeatures } from "./features.ts";
export { runSampleCompanyProvisioning } from "./provisioning-job.ts";
export type {
  SampleCompanyProvisioningProgress,
  SampleCompanyProvisioningRequest,
} from "./provisioning-job.ts";
export { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";

export { sampleRefreshPlan, refreshSampleCompany, refreshAllSampleCompanies } from "./refresh.ts";

export type { SampleOperatorOptions } from "./operator.ts";

export { SampleLocalAuthorRequiredError } from "./operator.ts";
