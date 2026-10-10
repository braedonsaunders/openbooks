/** Deterministic volume targets are operating policy, independent of random generation. */
export interface SampleOperatingPolicy {
  vendorBills: number; customerInvoices: number; postedVendorBills: number; postedCustomerInvoices: number;
  examplesPerOtherKind: number; historyMonths: number; vendors: number; customers: number;
}
const standard: SampleOperatingPolicy = { vendorBills: 36, customerInvoices: 18, postedVendorBills: 24, postedCustomerInvoices: 12, examplesPerOtherKind: 3, historyMonths: 3, vendors: 6, customers: 4 };
export const SAMPLE_OPERATING_POLICIES: Record<string, SampleOperatingPolicy> = {
  general_business: { ...standard },
  construction_contractor: { ...standard, vendorBills: 48, postedVendorBills: 36 },
  professional_services: { ...standard, customerInvoices: 24, postedCustomerInvoices: 18 },
  engineering_architecture: { ...standard, vendorBills: 42, postedVendorBills: 30 },
  it_software_saas: { ...standard, customerInvoices: 36, postedCustomerInvoices: 24 },
  accounting_firm: { ...standard, customerInvoices: 30, postedCustomerInvoices: 24 },
  wholesale_distribution: { ...standard, vendorBills: 72, customerInvoices: 48, postedVendorBills: 60, postedCustomerInvoices: 36 },
  property_management: { ...standard, vendorBills: 48, customerInvoices: 30, postedVendorBills: 36, postedCustomerInvoices: 24 },
  nonprofit: { ...standard },
  manufacturing: { ...standard, vendorBills: 60, customerInvoices: 36, postedVendorBills: 48, postedCustomerInvoices: 24 },
  healthcare_practice: { ...standard, vendorBills: 42, customerInvoices: 30, postedVendorBills: 30, postedCustomerInvoices: 24 },
};
export function sampleOperatingPolicy(industryKey: string): SampleOperatingPolicy {
  const policy = SAMPLE_OPERATING_POLICIES[industryKey];
  if (!policy) throw new Error(`Missing sample operating policy for ${industryKey}`);
  return policy;
}
