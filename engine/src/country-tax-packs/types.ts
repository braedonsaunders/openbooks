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
  ratePercent: string;
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
  /** Namespaced key resolved by a registered statement input provider. */
  inputKey?: string;
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
   * (the panel once branched on the literal `CA_GST34` code
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
  ratePercent: string;
  rates?: readonly EffectiveTaxRate[];
  role?: CountryTaxCodeRole;
  /**
   * Government return boxes (lineCodes on the owning return pack) this
   * code's output is reported in. Declared only when the box labels do not
   * name the rate in numbers (word-labelled bands such as "tarifa
   * general"); the statutory-fidelity test verifies every entry exists on
   * the return. Absent when a rate-mentioning box already routes the code,
   * or with workpaperOnlyReason when no government box carries it.
   */
  returnBoxes?: readonly string[];
  /**
   * Reviewed reason this code prices with no government return box: within
   * the modelled boxes its amounts land only in the OB workpaper boxes.
   * The statutory-fidelity test requires this to be non-empty whenever the
   * code is otherwise unroutable.
   */
  workpaperOnlyReason?: string;
  /**
   * Reviewed reason the rate schedule opens at source applicability rather
   * than at the band's origin (primary history unreachable or refused).
   * Required by the statutory-fidelity test whenever the opening row's
   * effectiveFrom equals the cited source's asOf fetch date.
   */
  truncatedScheduleReason?: string;
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
 * One rate band of a contractor withholding scheme (for example the UK CIS
 * "net" band). The rate schedule is effective-dated so a statutory change
 * never reprices a payment already made.
 */
export interface ContractorWithholdingBand {
  code: string;
  name: string;
  rates: readonly EffectiveTaxRate[];
  /** A payee is deducted at this band only on a verification current at the payment date. */
  requiresVerification: boolean;
  /** The exemption instrument has a finite validity period that must be recorded. */
  verificationRequiresEndDate?: boolean;
}

/**
 * Annual per-payee exemption limit. The declared amounts are thresholds of
 * the Freigrenze kind: while a payee's consideration for the calendar year
 * stays at or below the limit nothing is deducted, and once it is exceeded
 * the whole year's consideration becomes subject to deduction.
 */
export interface ContractorWithholdingThreshold {
  excludesVerifiedZeroRateConsideration?: boolean;
  excessCatchUpNotDue?: boolean;
  limits: ReadonlyArray<{
    amount: string;
    effectiveFrom: string;
    effectiveTo?: string;
    /** Enrollment basis that selects this limit; absent for the general limit. */
    basis?: string;
    sourceId: string;
  }>;
}

/** Statutory due date relative to the end of a deduction period. */
export interface ContractorWithholdingDueRule {
  dayOfMonth: number;
  monthsAfterPeriodEnd: number;
}

export interface ContractorWithholdingRemittanceSchedule {
  code: string;
  name: string;
  kind: "monthly" | "italian_accumulated" | "us_lookback" | "us_monthly" | "us_semiweekly" | "us_annual_small_liability";
  effectiveFrom: string;
  effectiveTo?: string;
  dayOfMonth?: number;
  /** Accumulated withholding, distinct from a payee exemption threshold. */
  accumulationThreshold?: string;
  mandatoryCutoffs?: readonly { month: number; day: number }[];
  sourceId: string;
}

/** An invoice policy template installed onto native tax codes, never a second tax engine. */
export interface ContractorReverseChargeRuleDefinition {
  code: string;
  country: string;
  name: string;
  legalReference: string;
  invoiceWording: string;
  effectiveFrom: string;
  applicability: string;
  calculationType: "reverse_charge";
  einvoiceCategory: "AE";
  sources: readonly CountryTaxPackSource[];
}

/**
 * A statutory scheme under which a contractor deducts tax from payments to
 * subcontractors and pays it to the authority (UK CIS, German Bauabzugsteuer,
 * Irish RCT). Packs declare schemes; the generic withholding engine branches
 * only on these declarations.
 */
export interface ContractorWithholdingSchemeDefinition {
  code: string;
  country: string;
  name: string;
  authority: string;
  legalReference: string;
  /** Currency the scheme's returns and limits are denominated in. */
  currency: string;
  /** What the rate applies to: the payment, less what the scheme removes first. */
  base: { excludesMaterials: boolean; excludesVat: boolean };
  bands: readonly ContractorWithholdingBand[];
  /** Band applied when no current verification supports a lower one; the highest rate. */
  defaultBandCode: string;
  /** The native vendor flag is the sole subject determination for US backup withholding. */
  standingSource?: "recorded_standing" | "vendor_backup_withholding";
  /** Enrollment must explicitly identify a condominium payer for Italian art. 25-ter. */
  payerScope?: "condominium";
  returnKind?: "statutory_periodic" | "annual_945" | "financial_workpaper";
  returnFrequency?: "monthly" | "quarterly" | "annual";
  returnFrequencies?: readonly ("monthly" | "quarterly" | "annual")[];
  filingNotice?: string;
  remittanceSchedules?: readonly ContractorWithholdingRemittanceSchedule[];
  threshold?: ContractorWithholdingThreshold;
  /** Monthly deduction periods starting on this day of the month. */
  periodStartDay: number;
  returnDue: ContractorWithholdingDueRule | null;
  paymentDue: ContractorWithholdingDueRule | null;
  /** Whether each payment needs an authority-issued deduction authorisation before it is made. */
  paymentAuthorisation: "none" | "required";
  /** Label of the contractor's scheme registration reference. */
  contractorReferenceLabel: string;
  /** Label of the payee's tax reference reported on returns and statements. */
  payeeReferenceLabel: string;
  /** Label of the verification evidence that supports a reduced band. */
  verificationLabel: string;
  /** Enrollment bases that select an alternative threshold limit. */
  thresholdBases?: ReadonlyArray<{ code: string; name: string }>;
  sources: readonly CountryTaxPackSource[];
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
  /** Contractor withholding schemes this country operates. */
  contractorWithholdingSchemes?: readonly ContractorWithholdingSchemeDefinition[];
  reverseChargeRules?: readonly ContractorReverseChargeRuleDefinition[];
}
