export type IndirectTaxType =
  | "vat"
  | "gst"
  | "hst"
  | "pst"
  | "qst"
  | "sales_use"
  | "consumption"
  | "other";

export interface EffectiveTaxRate {
  ratePercent: number;
  effectiveFrom: string;
  effectiveTo?: string;
  /** Stable id of the authoritative source in the owning country pack. */
  sourceId: string;
}

export type TaxBoxBasis = "tax_collected" | "tax_paid" | "taxable_base";
export type TaxBoxMap = "sales" | "purchases";

export interface TaxReturnPackBox {
  lineCode: string;
  label: string;
  sign: number;
  sequence: number;
  basis?: TaxBoxBasis;
  formula?: string;
  glMap?: TaxBoxMap;
}

export interface TaxReturnPackJurisdiction {
  code: string;
  name: string;
  country: string;
  region?: string;
  level: "country" | "state" | "county" | "city" | "special" | "federal";
  taxType: IndirectTaxType;
}

export interface TaxReturnPack {
  code: string;
  name: string;
  country: string;
  jurisdiction: TaxReturnPackJurisdiction;
  defaultFrequency: "monthly" | "bimonthly" | "quarterly" | "semiannual" | "annual";
  submissionChannel: "print_pdf" | "file_upload" | "efile_api" | "portal_manual";
  governmentFormat: "portal_entry" | "certified_file" | "api" | "paper";
  submissionUrl: string;
  watermark: string;
  boxes: readonly TaxReturnPackBox[];
}

export interface CountryTaxCodeDefinition {
  code: string;
  name: string;
  ratePercent: number;
  rates?: readonly EffectiveTaxRate[];
}

export type CountryPackCoverage = "detailed_pack" | "country_tax_setup" | "jurisdiction_setup";

export interface CountryTaxJurisdictionDefinition {
  region: string;
  name: string;
  taxType: IndirectTaxType;
  coverage: CountryPackCoverage;
  /** Maintained detailed return definition, when the country pack supplies one. */
  returnPackCode?: string;
  /** Draft only; the installer never activates an unconfirmed registration. */
  createDraftRegistration: boolean;
  /** Effective-dated jurisdiction code. Omit rather than invent an unknown rate. */
  defaultTaxCode?: CountryTaxCodeDefinition;
}

export interface CountryTaxPackSource {
  id: string;
  title: string;
  url: string;
  asOf: string;
}

export type CountryTaxPackCompletenessLevel = "complete" | "partial" | "not_applicable";

export interface CountryTaxPackCompleteness {
  jurisdictions: CountryTaxPackCompletenessLevel;
  standardRates: CountryTaxPackCompletenessLevel;
  returnDefinitions: CountryTaxPackCompletenessLevel;
  localRates: CountryTaxPackCompletenessLevel;
  taxability: CountryTaxPackCompletenessLevel;
  sourcingRules: CountryTaxPackCompletenessLevel;
  nexusRules: CountryTaxPackCompletenessLevel;
}

/**
 * Versioned localization content. Installation copies controlled definitions
 * into tenant-owned tax tables; tenants never post against this in-memory
 * catalog directly and an upgrade never silently rewrites installed history.
 */
export interface CountryTaxPackDefinition {
  code: string;
  version: string;
  country: string;
  name: string;
  countryTaxType: IndirectTaxType;
  parentReturnPackCode: string | null;
  /** Tax types that the country-level return aggregates. */
  parentReturnIncludedTaxTypes?: readonly IndirectTaxType[];
  completeness: CountryTaxPackCompleteness;
  sources: readonly CountryTaxPackSource[];
  jurisdictions: readonly CountryTaxJurisdictionDefinition[];
  returnPacks: readonly TaxReturnPack[];
  returnPackTaxCodes: Readonly<Record<string, CountryTaxCodeDefinition>>;
}
