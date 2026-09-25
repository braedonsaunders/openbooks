/** Setup-registry static option lists (split from registry.ts; pure moves only). */
const APPLIES_TO = [
  { value: 'sales', labelKey: 'options.appliesTo.sales' },
  { value: 'purchases', labelKey: 'options.appliesTo.purchases' },
  { value: 'both', labelKey: 'options.appliesTo.both' },
]

const TAX_CALCULATION_TYPES = [
  { value: 'standard', labelKey: 'options.taxCalculationType.standard' },
  { value: 'withholding', labelKey: 'options.taxCalculationType.withholding' },
  { value: 'reverse_charge', labelKey: 'options.taxCalculationType.reverseCharge' },
]

// Values match the tax_report_lines.basis enum (schema/src/tax.ts) and the tax
// return engine: tax_amount sums the tax collected/paid, taxable_base sums the
// base the tax applied to.
const TAX_BASIS = [
  { value: 'tax_collected', labelKey: 'options.basis.collected' },
  { value: 'tax_paid', labelKey: 'options.basis.paid' },
  { value: 'tax_amount', labelKey: 'options.basis.tax' },
  { value: 'taxable_base', labelKey: 'options.basis.net' },
]

const SUBMISSION_CHANNELS = [
  { value: 'print_pdf', labelKey: 'options.channel.printPdf' },
  { value: 'file_upload', labelKey: 'options.channel.fileUpload' },
  { value: 'efile_api', labelKey: 'options.channel.efileApi' },
  { value: 'portal_manual', labelKey: 'options.channel.portalManual' },
]

const GOVERNMENT_FORMATS = [
  { value: 'portal_entry', labelKey: 'options.governmentFormat.portalEntry' },
  { value: 'certified_file', labelKey: 'options.governmentFormat.certifiedFile' },
  { value: 'api', labelKey: 'options.governmentFormat.api' },
  { value: 'paper', labelKey: 'options.governmentFormat.paper' },
]

const TAX_SIGN = [
  { value: '1', labelKey: 'options.sign.positive' },
  { value: '-1', labelKey: 'options.sign.negative' },
]

// Values match the tax_jurisdictions.level / tax_type enums (schema/src/tax.ts).
const JURISDICTION_LEVELS = [
  { value: 'country', labelKey: 'options.jurisdictionLevel.country' },
  { value: 'state', labelKey: 'options.jurisdictionLevel.state' },
  { value: 'county', labelKey: 'options.jurisdictionLevel.county' },
  { value: 'city', labelKey: 'options.jurisdictionLevel.city' },
  { value: 'special', labelKey: 'options.jurisdictionLevel.special' },
  { value: 'federal', labelKey: 'options.jurisdictionLevel.federal' },
]

const TAX_TYPES = [
  { value: 'vat', labelKey: 'options.taxType.vat' },
  { value: 'gst', labelKey: 'options.taxType.gst' },
  { value: 'hst', labelKey: 'options.taxType.hst' },
  { value: 'pst', labelKey: 'options.taxType.pst' },
  { value: 'qst', labelKey: 'options.taxType.qst' },
  { value: 'sales_use', labelKey: 'options.taxType.salesUse' },
  { value: 'consumption', labelKey: 'options.taxType.consumption' },
  { value: 'other', labelKey: 'options.taxType.other' },
]

// Values match the tax_registrations.filing_frequency enum (schema/src/tax.ts).
const FILING_FREQUENCIES = [
  { value: 'monthly', labelKey: 'options.filingFrequency.monthly' },
  { value: 'bimonthly', labelKey: 'options.filingFrequency.bimonthly' },
  { value: 'quarterly', labelKey: 'options.filingFrequency.quarterly' },
  { value: 'semiannual', labelKey: 'options.filingFrequency.semiannual' },
  { value: 'annual', labelKey: 'options.filingFrequency.annual' },
]

// Values match the tax_pool_classes.method enum (schema/src/tax-pools.ts).
const POOL_METHODS = [
  { value: 'declining', labelKey: 'options.poolMethod.declining' },
  { value: 'straight_line', labelKey: 'options.poolMethod.straightLine' },
]

const TAX_DEPRECIATION_MODELS = [
  { value: 'pool', labelKey: 'options.taxDepreciationModel.pool' },
  { value: 'macrs', labelKey: 'options.taxDepreciationModel.macrs' },
]

const MACRS_SYSTEMS = [
  { value: 'gds', labelKey: 'options.macrsSystem.gds' },
  { value: 'ads', labelKey: 'options.macrsSystem.ads' },
]

const MACRS_METHODS = [
  { value: '200_db', labelKey: 'options.macrsMethod.200db' },
  { value: '150_db', labelKey: 'options.macrsMethod.150db' },
  { value: 'straight_line', labelKey: 'options.macrsMethod.straightLine' },
]

const TAX_DEPRECIATION_CONVENTIONS = [
  { value: 'half_year', labelKey: 'options.taxDepreciationConvention.halfYear' },
  { value: 'mid_quarter', labelKey: 'options.taxDepreciationConvention.midQuarter' },
  { value: 'mid_month', labelKey: 'options.taxDepreciationConvention.midMonth' },
]

const DEPRECIATION_METHODS = [
  { value: 'straight_line', labelKey: 'options.method.straightLine' },
  { value: 'declining_balance', labelKey: 'options.method.decliningBalance' },
  { value: 'double_declining', labelKey: 'options.method.doubleDeclining' },
  { value: 'units_of_production', labelKey: 'options.method.unitsOfProduction' },
  { value: 'manual', labelKey: 'options.method.manual' },
]

const DEPRECIATION_CONVENTIONS = [
  { value: 'full_month', labelKey: 'options.convention.fullMonth' },
  { value: 'mid_month', labelKey: 'options.convention.midMonth' },
  { value: 'half_year', labelKey: 'options.convention.halfYear' },
]

const END_OF_LIFE = [
  { value: 'fully_depreciate', labelKey: 'options.endOfLife.fullyDepreciate' },
  { value: 'retain_balance', labelKey: 'options.endOfLife.retainBalance' },
]

export const OVERHEAD_RATE_KINDS = [
  { value: 'per_hour', labelKey: 'options.overheadRateKind.per_hour' },
  { value: 'percent', labelKey: 'options.overheadRateKind.percent' },
]

const FX_RATE_TYPES = [
  { value: 'spot', labelKey: 'options.fxRateType.spot' },
  { value: 'average', labelKey: 'options.fxRateType.average' },
  { value: 'historical', labelKey: 'options.fxRateType.historical' },
]

const CONSOLIDATED_RATE_SOURCES = [
  { value: 'derived', labelKey: 'options.rateSource.derived' },
  { value: 'manual', labelKey: 'options.rateSource.manual' },
]

// --- Payroll ----------------------------------------------------------------

// Values match pay_schedules.frequency (schema/src/payroll.ts). Periods per
// year stays an explicit field so 53/27-period years can be configured.
const PAY_FREQUENCIES = [
  { value: 'weekly', labelKey: 'options.payFrequency.weekly' },
  { value: 'biweekly', labelKey: 'options.payFrequency.biweekly' },
  { value: 'semi_monthly', labelKey: 'options.payFrequency.semiMonthly' },
  { value: 'monthly', labelKey: 'options.payFrequency.monthly' },
]

const PAY_COMPONENT_KINDS = [
  { value: 'earning', labelKey: 'options.payComponentKind.earning' },
  { value: 'deduction', labelKey: 'options.payComponentKind.deduction' },
  { value: 'employer_contribution', labelKey: 'options.payComponentKind.employerContribution' },
]

/**
 * STATIC FALLBACK ONLY for every pay-component / filing-account country
 * picker — server surfaces replace these with the pack registry's
 * installable packs (`optionsSource`, resolved by
 * resolveDynamicSetupOptions). The fallback must still name every
 * installable pack: an unresolved surface showing only CA/US is the defect
 * this file once shipped, and the write path validates against the fallback
 * where it never resolved. Labels are the packs' own names (CA/US keep
 * their translated keys); the parity test below pins the value set to the
 * registry, so a fifteenth pack fails until this snapshot grows.
 */
const PAY_COMPONENT_COUNTRIES = [
  { value: 'CA', labelKey: 'options.payComponentCountry.CA' },
  { value: 'US', labelKey: 'options.payComponentCountry.US' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'IE', label: 'Ireland' },
  { value: 'AU', label: 'Australia' },
  { value: 'IT', label: 'Italy' },
  { value: 'NL', label: 'Netherlands' },
  { value: 'ES', label: 'Spain' },
  { value: 'SG', label: 'Singapore' },
  { value: 'JP', label: 'Japan' },
  { value: 'PL', label: 'Poland' },
  { value: 'BR', label: 'Brazil' },
]

const PAY_COMPONENT_BASES = [
  { value: 'fixed_amount', labelKey: 'options.payComponentBasis.fixedAmount' },
  { value: 'per_hour', labelKey: 'options.payComponentBasis.perHour' },
  { value: 'percent_of_gross', labelKey: 'options.payComponentBasis.percentOfGross' },
]

const PAY_SUPPLEMENTAL_WAGE_CATEGORIES = [
  { value: 'bonus_or_stock_option', label: 'Bonus or stock option' },
  { value: 'other', label: 'Other supplemental wage' },
]

// Federally exempt compensation classes (migration 0407). Static labels like
// the supplemental categories above: the values are federal statute classes,
// not locale strings.
const PAY_STATUTORY_EXEMPTION_CATEGORIES = [
  { value: 'military_pay', label: 'Military pay (nonresident exclusion)' },
  { value: 'rail_carrier', label: 'Rail carrier pay (49 USC 11502)' },
  { value: 'motor_carrier', label: 'Motor carrier pay (49 USC 14503)' },
  { value: 'air_carrier', label: 'Air carrier pay (49 USC 40116(f))' },
  { value: 'seafarer', label: 'Seafarer wages (46 USC 11108(a))' },
]

// STATIC FALLBACK ONLY for the pay-component treatment picker — server
// surfaces replace these with the component's pack-declared treatments
// (`optionsSource: 'payroll-deduction-treatments'`, resolved by
// resolveDynamicSetupOptions), so an AU component offers salary sacrifice
// and a CA one the T4127 factors (F, U1, F2) with no edit here.
const PAY_TAX_TREATMENTS = [
  { value: 'none', labelKey: 'options.payTaxTreatment.none' },
  { value: 'pension_f', labelKey: 'options.payTaxTreatment.pensionF' },
  { value: 'union_dues', labelKey: 'options.payTaxTreatment.unionDues' },
  { value: 'alimony', labelKey: 'options.payTaxTreatment.alimony' },
  // Every pack-declared treatment key must appear here too: the write path
  // validates against this fallback where it never resolved, so a missing
  // key is a refusal of a treatment the picker offers. The parity test pins
  // the value set to the derived cross-pack union.
  { value: 'salary_sacrifice', label: 'Salary sacrifice (PAYG)' },
]

// Protected-earnings base a garnishment/support order is measured against
// (Ontario Wages Act net wages, US CCPA disposable earnings, or plain gross).
const PAY_PROTECTION_BASES = [
  { value: 'none', labelKey: 'options.payProtectionBase.none' },
  { value: 'net_pay', labelKey: 'options.payProtectionBase.netPay' },
  { value: 'disposable_earnings', labelKey: 'options.payProtectionBase.disposableEarnings' },
  { value: 'gross', labelKey: 'options.payProtectionBase.gross' },
]

// The values of `protectionBase` that actually protect something — the
// percentage and priority only mean anything once a base is chosen.
const PAY_PROTECTED_BASES = ['net_pay', 'disposable_earnings', 'gross']

// Payroll filing identities: a CRA payroll program account (RP), a US federal
// EIN, or a state unemployment account (one per state, under an EIN).
// STATIC FALLBACK ONLY — server surfaces replace these with the pack
// registry's declared program types (`optionsSource:
// 'payroll-filing-program-types'`, resolved by resolveDynamicSetupOptions),
// so a registered third pack's program types appear without an edit here.
const PAYROLL_PROGRAM_TYPES = [
  { value: 'ca_rp', labelKey: 'options.payrollProgramType.caRp' },
  { value: 'us_ein', labelKey: 'options.payrollProgramType.usEin' },
  { value: 'us_state_sui', labelKey: 'options.payrollProgramType.usStateSui' },
  // Every pack-declared filing program type, in registry order: the write
  // path validates against this fallback where it never resolved, so a
  // missing type refuses an account the picker offers. Labels are the
  // declarations' own words (their statutory proper nouns); the parity test
  // pins the value set to the filing registry.
  { value: 'gb_paye', label: 'Employer PAYE reference' },
  { value: 'de_finanzamt', label: 'Betriebsstättenfinanzamt (ELSTER)' },
  { value: 'fr_siret', label: 'SIRET — établissement employeur (DSN)' },
  { value: 'ie_paye', label: 'PAYE/PRSI/USC employer registration (Revenue Commissioners)' },
  { value: 'ato_stp', label: 'Single Touch Payroll (STP)' },
  { value: 'it_sostituto', label: "Codice fiscale del sostituto d'imposta" },
  { value: 'nl_loonheffingen', label: 'Loonheffingen (payroll tax number)' },
  { value: 'es_tgss_ccc', label: 'TGSS código de cuenta de cotización (CCC)' },
  { value: 'sg_cpf', label: 'CPF Submission Number' },
  { value: 'jp_shaho_jigyosho', label: '社会保険適用事業所 (JPS-registered establishment)' },
  { value: 'pl_zus_platnik', label: 'ZUS konto płatnika składek (DRA)' },
  { value: 'br_cnpj_esocial', label: 'eSocial — CNPJ do estabelecimento' },
]

// CRA remittance frequency the account is registered under.
const PAYROLL_REMITTER_TYPES = [
  { value: 'regular', labelKey: 'options.payrollRemitterType.regular' },
  { value: 'quarterly', labelKey: 'options.payrollRemitterType.quarterly' },
  { value: 'accelerated_1', labelKey: 'options.payrollRemitterType.accelerated1' },
  { value: 'accelerated_2', labelKey: 'options.payrollRemitterType.accelerated2' },
]

// Entitlement plans (pay banks). Balances are MONEY by default and displayed
// in hours at the effective wage — an hours-denominated bank silently revalues
// as wages rise. Values match schema/src/payroll-entitlements.ts.
const ENTITLEMENT_UNITS = [
  { value: 'money', labelKey: 'options.entitlementUnit.money' },
  { value: 'hours', labelKey: 'options.entitlementUnit.hours' },
]

const ENTITLEMENT_DIRECTIONS = [
  { value: 'accrue', labelKey: 'options.entitlementDirection.accrue' },
  { value: 'owe', labelKey: 'options.entitlementDirection.owe' },
]

const ENTITLEMENT_ACCRUAL_METHODS = [
  { value: 'percent_of_earnings', labelKey: 'options.entitlementAccrualMethod.percentOfEarnings' },
  { value: 'per_hour_worked', labelKey: 'options.entitlementAccrualMethod.perHourWorked' },
  { value: 'fixed_per_period', labelKey: 'options.entitlementAccrualMethod.fixedPerPeriod' },
  { value: 'manual', labelKey: 'options.entitlementAccrualMethod.manual' },
]

const ENTITLEMENT_CAP_BEHAVIORS = [
  { value: 'warn', labelKey: 'options.entitlementCapBehavior.warn' },
  { value: 'block', labelKey: 'options.entitlementCapBehavior.block' },
  { value: 'auto_payout', labelKey: 'options.entitlementCapBehavior.autoPayout' },
]

// --- Subcontractor compliance ----------------------------------------------

const COMPLIANCE_CATEGORIES = [
  { value: 'insurance', labelKey: 'options.complianceCategory.insurance' },
  { value: 'tax_form', labelKey: 'options.complianceCategory.taxForm' },
  { value: 'licence', labelKey: 'options.complianceCategory.licence' },
  { value: 'bond', labelKey: 'options.complianceCategory.bond' },
  { value: 'safety', labelKey: 'options.complianceCategory.safety' },
  { value: 'other', labelKey: 'options.complianceCategory.other' },
]

// What a lapse does. `block_bill` is strictly stronger than `block_payment`:
// evidence that stops a bill being recorded also stops its cash leaving.
const COMPLIANCE_ENFORCEMENT = [
  { value: 'advisory', labelKey: 'options.complianceEnforcement.advisory' },
  { value: 'warn', labelKey: 'options.complianceEnforcement.warn' },
  { value: 'block_payment', labelKey: 'options.complianceEnforcement.blockPayment' },
  { value: 'block_bill', labelKey: 'options.complianceEnforcement.blockBill' },
]

const LIEN_WAIVER_ENFORCEMENT = [
  { value: 'none', labelKey: 'options.lienWaiverEnforcement.none' },
  { value: 'warn', labelKey: 'options.lienWaiverEnforcement.warn' },
  { value: 'block', labelKey: 'options.lienWaiverEnforcement.block' },
]

export const LIEN_WAIVER_TYPES = [
  { value: 'conditional_progress', labelKey: 'options.lienWaiverType.conditionalProgress' },
  { value: 'unconditional_progress', labelKey: 'options.lienWaiverType.unconditionalProgress' },
  { value: 'conditional_final', labelKey: 'options.lienWaiverType.conditionalFinal' },
  { value: 'unconditional_final', labelKey: 'options.lienWaiverType.unconditionalFinal' },
]

const INFORMATION_RETURN_FORM_TYPES = [
  { value: '1099-NEC', labelKey: 'options.informationReturnForm.nec' },
  { value: '1099-MISC', labelKey: 'options.informationReturnForm.misc' },
  { value: 'T4A', labelKey: 'options.informationReturnForm.t4a' },
]

/** The class-level default adds "not reportable" to the real form types. */
const INFORMATION_RETURN_FORMS_OPTIONS = [
  { value: 'none', labelKey: 'options.informationReturnForm.none' },
  ...INFORMATION_RETURN_FORM_TYPES,
]

/**
 * Statutory boxes across all three forms, flattened for the box-rule picker.
 * Kept in sync with INFORMATION_RETURN_FORMS in
 * engine/src/compliance/information-returns.ts (asserted by registry.test.ts) — the boxes
 * are law, so they live in code; which ACCOUNT feeds which box is the org's
 * configuration and lives in the table.
 */
const INFORMATION_RETURN_BOXES = [
  { value: 'nec1', labelKey: 'options.informationReturnBox.nec1' },
  { value: 'nec2', labelKey: 'options.informationReturnBox.nec2' },
  { value: 'nec4', labelKey: 'options.informationReturnBox.nec4' },
  { value: 'misc1', labelKey: 'options.informationReturnBox.misc1' },
  { value: 'misc2', labelKey: 'options.informationReturnBox.misc2' },
  { value: 'misc3', labelKey: 'options.informationReturnBox.misc3' },
  { value: 'misc4', labelKey: 'options.informationReturnBox.misc4' },
  { value: 'misc5', labelKey: 'options.informationReturnBox.misc5' },
  { value: 'misc6', labelKey: 'options.informationReturnBox.misc6' },
  { value: 'misc8', labelKey: 'options.informationReturnBox.misc8' },
  { value: 'misc9', labelKey: 'options.informationReturnBox.misc9' },
  { value: 'misc10', labelKey: 'options.informationReturnBox.misc10' },
  { value: 'misc11', labelKey: 'options.informationReturnBox.misc11' },
  { value: 'misc12', labelKey: 'options.informationReturnBox.misc12' },
  { value: 'misc14', labelKey: 'options.informationReturnBox.misc14' },
  { value: 'misc15', labelKey: 'options.informationReturnBox.misc15' },
  { value: 't4a020', labelKey: 'options.informationReturnBox.t4a020' },
  { value: 't4a048', labelKey: 'options.informationReturnBox.t4a048' },
  { value: 't4a022', labelKey: 'options.informationReturnBox.t4a022' },
]

// Revenue recognition (ASC 606 / IFRS 15) — mirrors source platform ARM rule methods.
const RECOGNITION_METHODS = [
  { value: 'point_in_time', labelKey: 'options.recognitionMethod.pointInTime' },
  { value: 'straight_line_even', labelKey: 'options.recognitionMethod.straightLineEven' },
  { value: 'straight_line_prorate_first_last', labelKey: 'options.recognitionMethod.straightLineProrate' },
  { value: 'straight_line_daily', labelKey: 'options.recognitionMethod.straightLineDaily' },
  { value: 'percent_complete', labelKey: 'options.recognitionMethod.percentComplete' },
  { value: 'milestone', labelKey: 'options.recognitionMethod.milestone' },
  { value: 'usage', labelKey: 'options.recognitionMethod.usage' },
]

const START_DATE_SOURCES = [
  { value: 'obligation', labelKey: 'options.startDateSource.obligation' },
  { value: 'document', labelKey: 'options.startDateSource.document' },
  { value: 'fulfillment', labelKey: 'options.startDateSource.fulfillment' },
  { value: 'event', labelKey: 'options.startDateSource.event' },
  { value: 'contract', labelKey: 'options.startDateSource.contract' },
]

const END_DATE_SOURCES = [
  { value: 'term', labelKey: 'options.endDateSource.term' },
  { value: 'obligation', labelKey: 'options.endDateSource.obligation' },
  { value: 'contract', labelKey: 'options.endDateSource.contract' },
]

// Inventory costing — matches item_inventory_profiles + stock_locations enums.
const COSTING_METHODS = [
  { value: 'fifo', labelKey: 'options.costingMethod.fifo' },
  { value: 'moving_average', labelKey: 'options.costingMethod.movingAverage' },
  { value: 'standard', labelKey: 'options.costingMethod.standard' },
]

const INVENTORY_TRACKING = [
  { value: 'none', labelKey: 'options.tracking.none' },
  { value: 'lot', labelKey: 'options.tracking.lot' },
  { value: 'serial', labelKey: 'options.tracking.serial' },
]

const STOCK_LOCATION_KINDS = [
  { value: 'warehouse', labelKey: 'options.stockLocationKind.warehouse' },
  { value: 'zone', labelKey: 'options.stockLocationKind.zone' },
  { value: 'bin', labelKey: 'options.stockLocationKind.bin' },
  { value: 'staging', labelKey: 'options.stockLocationKind.staging' },
  { value: 'transit', labelKey: 'options.stockLocationKind.transit' },
  { value: 'quarantine', labelKey: 'options.stockLocationKind.quarantine' },
]

const CONSOLIDATION_METHODS = [
  { value: 'full', labelKey: 'options.consolidationMethod.full' },
  { value: 'proportionate', labelKey: 'options.consolidationMethod.proportionate' },
  { value: 'equity', labelKey: 'options.consolidationMethod.equity' },
]

// HR-15: home announcement audience scope options.
const HOME_ANNOUNCEMENT_AUDIENCES = [
  { value: 'all', labelKey: 'options.announcementAudience.all' },
  { value: 'managers', labelKey: 'options.announcementAudience.managers' },
  { value: 'employees', labelKey: 'options.announcementAudience.employees' },
]

const NCI_MEASUREMENTS = [
  { value: 'proportionate', labelKey: 'options.nciMeasurement.proportionate' },
  { value: 'fair_value', labelKey: 'options.nciMeasurement.fairValue' },
]


// Shared with entities/* (split from registry.ts; these were module-private there).
export { APPLIES_TO, TAX_CALCULATION_TYPES, TAX_BASIS, SUBMISSION_CHANNELS, GOVERNMENT_FORMATS, TAX_SIGN, JURISDICTION_LEVELS, TAX_TYPES, FILING_FREQUENCIES, POOL_METHODS, TAX_DEPRECIATION_MODELS, MACRS_SYSTEMS, MACRS_METHODS, TAX_DEPRECIATION_CONVENTIONS, DEPRECIATION_METHODS, DEPRECIATION_CONVENTIONS, END_OF_LIFE, FX_RATE_TYPES, CONSOLIDATED_RATE_SOURCES, PAY_FREQUENCIES, PAY_COMPONENT_KINDS, PAY_COMPONENT_COUNTRIES, PAY_COMPONENT_BASES, PAY_SUPPLEMENTAL_WAGE_CATEGORIES, PAY_STATUTORY_EXEMPTION_CATEGORIES, PAY_TAX_TREATMENTS, PAY_PROTECTION_BASES, PAY_PROTECTED_BASES, PAYROLL_PROGRAM_TYPES, PAYROLL_REMITTER_TYPES, ENTITLEMENT_UNITS, ENTITLEMENT_DIRECTIONS, ENTITLEMENT_ACCRUAL_METHODS, ENTITLEMENT_CAP_BEHAVIORS, COMPLIANCE_CATEGORIES, COMPLIANCE_ENFORCEMENT, LIEN_WAIVER_ENFORCEMENT, INFORMATION_RETURN_FORM_TYPES, INFORMATION_RETURN_FORMS_OPTIONS, INFORMATION_RETURN_BOXES, RECOGNITION_METHODS, START_DATE_SOURCES, END_DATE_SOURCES, COSTING_METHODS, INVENTORY_TRACKING, STOCK_LOCATION_KINDS, CONSOLIDATION_METHODS, HOME_ANNOUNCEMENT_AUDIENCES, NCI_MEASUREMENTS }
