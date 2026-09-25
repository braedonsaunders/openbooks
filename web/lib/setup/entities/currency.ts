/** Setup-registry currency entities (split from registry.ts; pure moves only). */
import type { SetupEntity } from '../types'
import { FX_RATE_TYPES, CONSOLIDATED_RATE_SOURCES, COMPLIANCE_CATEGORIES, COMPLIANCE_ENFORCEMENT, LIEN_WAIVER_ENFORCEMENT, LIEN_WAIVER_TYPES, INFORMATION_RETURN_FORM_TYPES, INFORMATION_RETURN_FORMS_OPTIONS, INFORMATION_RETURN_BOXES } from '../options'
import { RECRUITING_INTERVIEWER_POOLS_ENTITY, RECRUITING_KIT_ATTRIBUTES_ENTITY, RECRUITING_KIT_QUESTIONS_ENTITY, RECRUITING_KITS_ENTITY, RECRUITING_OFFER_TEMPLATES_ENTITY, RECRUITING_RETENTION_RULES_ENTITY } from '../hrm-recruiting'

export const CURRENCY_ENTITIES: SetupEntity[] = [
  // --- Currency ------------------------------------------------------------
  {
    key: 'fx-rates',
    table: 'fx_rates',
    actorCols: true,
    groupKey: 'currency',
    iconKey: 'coins',
    featureKey: 'multiCurrency',
    orgScoped: true,
    orderBy: 'as_of desc',
    hasActive: false,
    columns: [
      { key: 'asOf', kind: 'date' },
      { key: 'fromCurrency', kind: 'code' },
      { key: 'toCurrency', kind: 'code' },
      { key: 'rateType', kind: 'text' },
      { key: 'rate', kind: 'number' },
      { key: 'source', kind: 'text' },
    ],
    fields: [
      { key: 'asOf', kind: 'date', required: true, lockedOnEdit: true },
      { key: 'fromCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'toCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'rateType', kind: 'select', required: true, options: FX_RATE_TYPES, lockedOnEdit: true },
      { key: 'rate', kind: 'decimal', required: true },
      { key: 'source', kind: 'text', lockedOnEdit: true, keepDefault: true },
    ],
  },
  {
    key: 'consolidated-fx-rates',
    table: 'consolidated_fx_rates',
    actorCols: true,
    groupKey: 'currency',
    iconKey: 'layers',
    featureKey: 'multiSubsidiary',
    orgScoped: true,
    orderBy: 'period_id desc',
    hasActive: false,
    columns: [
      { key: 'periodId', kind: 'ref', ref: 'accounting-periods' },
      { key: 'fromCurrency', kind: 'code' },
      { key: 'toCurrency', kind: 'code' },
      { key: 'currentRate', kind: 'number' },
      { key: 'averageRate', kind: 'number' },
      { key: 'historicalRate', kind: 'number' },
      { key: 'source', kind: 'text' },
    ],
    fields: [
      { key: 'periodId', kind: 'ref', ref: 'accounting-periods', required: true, lockedOnEdit: true },
      { key: 'fromCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'toCurrency', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'currentRate', kind: 'decimal', required: true },
      { key: 'averageRate', kind: 'decimal', required: true },
      { key: 'historicalRate', kind: 'decimal', required: true },
      { key: 'source', kind: 'select', required: true, options: CONSOLIDATED_RATE_SOURCES },
    ],
  },
  // ── Subcontractor compliance ──────────────────────────────────────────
  // The policy layer of the compliance module. Nothing about what a
  // subcontractor must carry is hardcoded: the classes, the certificates, the
  // limits, and what a lapse does are all rows here.
  {
    key: 'compliance-classes',
    table: 'compliance_classes',
    singularTitleKey: 'entities.compliance-classes.singular',
    groupKey: 'compliance',
    iconKey: 'users',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    featureKey: 'subcontractorCompliance',
    docSlug: 'subcontractor-compliance',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'lienWaiverEnforcement', kind: 'badge', options: LIEN_WAIVER_ENFORCEMENT },
      { key: 'defaultInformationReturn', kind: 'badge', options: INFORMATION_RETURN_FORMS_OPTIONS },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      {
        key: 'lienWaiverEnforcement',
        kind: 'select',
        options: LIEN_WAIVER_ENFORCEMENT,
        keepDefault: true,
        helpTextKey: 'fieldHelp.lienWaiverEnforcement',
      },
      {
        key: 'defaultLienWaiverType',
        kind: 'select',
        // Conditionally required: the waiver_type_required CHECK refuses
        // enforcement without one (F-t03-007). Visible — and required —
        // only while enforcement is Warn/Block; with enforcement None the
        // drawer clears it, exactly as the CHECK expects.
        required: true,
        showWhen: { field: 'lienWaiverEnforcement', in: ['warn', 'block'] },
        options: LIEN_WAIVER_TYPES,
        helpTextKey: 'fieldHelp.defaultLienWaiverType',
      },
      {
        key: 'defaultInformationReturn',
        kind: 'select',
        options: INFORMATION_RETURN_FORMS_OPTIONS,
        keepDefault: true,
        helpTextKey: 'fieldHelp.defaultInformationReturn',
      },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'compliance-requirements',
    table: 'compliance_requirements',
    singularTitleKey: 'entities.compliance-requirements.singular',
    groupKey: 'compliance',
    iconKey: 'shield',
    orgScoped: true,
    actorCols: true,
    naturalKey: 'code',
    hasActive: true,
    featureKey: 'subcontractorCompliance',
    docSlug: 'subcontractor-compliance',
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'category', kind: 'badge', options: COMPLIANCE_CATEGORIES },
      { key: 'classId', kind: 'ref', ref: 'compliance-classes' },
      { key: 'minCoverageAmount', kind: 'number' },
      { key: 'enforcement', kind: 'badge', options: COMPLIANCE_ENFORCEMENT },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'category', kind: 'select', options: COMPLIANCE_CATEGORIES, keepDefault: true },
      {
        key: 'classId',
        kind: 'ref',
        ref: 'compliance-classes',
        helpTextKey: 'fieldHelp.complianceRequirementClass',
      },
      {
        key: 'enforcement',
        kind: 'select',
        options: COMPLIANCE_ENFORCEMENT,
        keepDefault: true,
        helpTextKey: 'fieldHelp.complianceEnforcement',
      },
      { key: 'requiresExpiry', kind: 'boolean', defaultValue: true, helpTextKey: 'fieldHelp.requiresExpiry' },
      { key: 'graceDays', kind: 'integer', keepDefault: true, defaultHintKey: 'fieldHelp.graceDaysHint' },
      { key: 'expiryWarningDays', kind: 'integer', keepDefault: true, defaultHintKey: 'fieldHelp.expiryWarningDaysHint' },
      {
        key: 'minCoverageAmount',
        kind: 'decimal',
        helpTextKey: 'fieldHelp.minCoverageAmount',
      },
      { key: 'minAggregateAmount', kind: 'decimal' },
      { key: 'coverageCurrency', kind: 'text', helpTextKey: 'fieldHelp.coverageCurrency' },
      { key: 'requiresAdditionalInsured', kind: 'boolean' },
      { key: 'requiresWaiverOfSubrogation', kind: 'boolean' },
      { key: 'requiresPrimaryNoncontributory', kind: 'boolean' },
      {
        key: 'requiresVerification',
        kind: 'boolean',
        defaultValue: true,
        helpTextKey: 'fieldHelp.requiresVerification',
      },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    // Which 1099/T4A box an account's spend belongs in. Anything unmapped falls
    // to the vendor's default box, so an org that reports everything as
    // nonemployee compensation configures nothing here at all.
    key: 'information-return-box-rules',
    table: 'information_return_box_rules',
    singularTitleKey: 'entities.information-return-box-rules.singular',
    groupKey: 'compliance',
    iconKey: 'receipt',
    orgScoped: true,
    actorCols: true,
    orderBy: 'form_type, box',
    hasActive: true,
    featureKey: 'subcontractorCompliance',
    docSlug: 'subcontractor-compliance',
    columns: [
      { key: 'formType', kind: 'badge', options: INFORMATION_RETURN_FORM_TYPES },
      { key: 'box', kind: 'badge', options: INFORMATION_RETURN_BOXES },
      { key: 'accountId', kind: 'ref', ref: 'accounts' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'formType', kind: 'select', options: INFORMATION_RETURN_FORM_TYPES, required: true },
      {
        key: 'box',
        kind: 'select',
        options: INFORMATION_RETURN_BOXES,
        required: true,
        helpTextKey: 'fieldHelp.informationReturnBox',
      },
      { key: 'accountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'isActive', kind: 'boolean' },
    ],
  },
  {
    key: 'currencies',
    table: 'currencies',
    idColumn: 'code',
    groupKey: 'currency',
    iconKey: 'coins',
    featureKey: 'multiCurrency',
    orgScoped: false,
    readOnly: true,
    naturalKey: 'code',
    orderBy: 'code',
    hasActive: false,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'minorUnits', kind: 'number' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'minorUnits', kind: 'integer', required: true },
    ],
  },
  // HR-18 begin: recruiting-depth configuration (0229), declared in
  // ./hrm-recruiting.ts; rehomed onto /hrm/recruiting (kits + pools on the
  // Interviews tab, offer templates on Offers, retention rules on Pools).
  RECRUITING_KITS_ENTITY,
  RECRUITING_KIT_ATTRIBUTES_ENTITY,
  RECRUITING_KIT_QUESTIONS_ENTITY,
  RECRUITING_INTERVIEWER_POOLS_ENTITY,
  RECRUITING_OFFER_TEMPLATES_ENTITY,
  RECRUITING_RETENTION_RULES_ENTITY,
  // HR-18 end
]
