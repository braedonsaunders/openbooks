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
  /**
   * Optional filing notice the generic prepare panel renders for this form
   * (F-w4-001: the panel used to branch on the literal `CA_GST34` code
   * instead). A `tax`-namespace message-catalog key, e.g.
   * "submission.gst34Notice" — never a country literal in UI code. Forms
   * that declare nothing render no notice.
   */
  noticeKey?: string;
  boxes: readonly TaxReturnPackBox[];
}

/**
 * Rate-band role of one code within its return's set. Declarative metadata,
 * not an enforced partition: real returns break every tidy rule (one return
 * can carry several reduced bands, or several codes none of which is a
 * "reduced" rate), so packs declare a role when it is meaningful and omit it
 * otherwise. Reserved as the key a future rate-specific return-box mapping
 * will match on; nothing today branches on it.
 */
export type CountryTaxCodeRole = "standard" | "reduced" | "zero" | "exempt";

export interface CountryTaxCodeDefinition {
  code: string;
  name: string;
  ratePercent: number;
  rates?: readonly EffectiveTaxRate[];
  role?: CountryTaxCodeRole;
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
  /**
   * Tax code SET per return pack code. A single definition (the common case
   * today) or a non-empty array when one return carries several codes, each
   * with its own effective-dated schedule. Keys must be return-pack codes of
   * this same pack — anything else is uninstallable and a structural test
   * rejects it. Read this field ONLY through packTaxCodesForReturn: it is the
   * sole normalizer of the two shapes, and a second inline reader is the bug
   * this union would otherwise become.
   */
  returnPackTaxCodes: Readonly<Record<string, CountryTaxCodeDefinition | readonly CountryTaxCodeDefinition[]>>;
}
