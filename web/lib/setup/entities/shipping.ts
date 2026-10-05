/** Setup-registry shipping entities, re-homed on the Shipping workspace. */
import type { SetupEntity, SetupOption } from '../types'

const DIM_UNITS: SetupOption[] = [
  { value: 'cm', labelKey: 'options.dimUnit.cm' },
  { value: 'in', labelKey: 'options.dimUnit.in' },
]

const WEIGHT_UNITS: SetupOption[] = [
  { value: 'g', labelKey: 'options.weightUnit.g' },
  { value: 'kg', labelKey: 'options.weightUnit.kg' },
  { value: 'oz', labelKey: 'options.weightUnit.oz' },
  { value: 'lb', labelKey: 'options.weightUnit.lb' },
]

const RATE_RULES: SetupOption[] = [
  { value: 'cheapest', labelKey: 'options.rateRule.cheapest' },
  { value: 'fastest', labelKey: 'options.rateRule.fastest' },
  { value: 'cheapest_by_date', labelKey: 'options.rateRule.cheapest_by_date' },
]

const INSURANCE_DEFAULTS: SetupOption[] = [
  { value: 'none', labelKey: 'options.insuranceDefault.none' },
  { value: 'carrier_full', labelKey: 'options.insuranceDefault.carrier_full' },
]

const SIGNATURE_DEFAULTS: SetupOption[] = [
  { value: 'none', labelKey: 'options.signatureDefault.none' },
  { value: 'direct', labelKey: 'options.signatureDefault.direct' },
  { value: 'adult', labelKey: 'options.signatureDefault.adult' },
]

export const SHIPPING_ENTITIES: SetupEntity[] = [
  {
    // Reusable box/envelope sizes for rate shopping. A preset with no
    // weight cannot price a label: rating refuses it by name and points
    // back here, so weight stays optional in storage but required in
    // practice. The default preset is chosen on the settings row, never
    // here, so two presets can never claim to be the default at once.
    key: 'package-presets',
    table: 'package_presets',
    singularTitleKey: 'entities.package-presets.singular',
    rehomed: true,
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'shippingHub',
    iconKey: 'package',
    orgScoped: true,
    naturalKey: 'name',
    orderBy: 'name',
    hasActive: false,
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'length', kind: 'number' },
      { key: 'width', kind: 'number' },
      { key: 'height', kind: 'number' },
      { key: 'weight', kind: 'number' },
      { key: 'weightUnit', kind: 'text' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      { key: 'length', kind: 'decimal', decimalScale: 4 },
      { key: 'width', kind: 'decimal', decimalScale: 4 },
      { key: 'height', kind: 'decimal', decimalScale: 4 },
      { key: 'dimUnit', kind: 'select', options: DIM_UNITS, defaultValue: 'cm', keepDefault: true },
      { key: 'weight', kind: 'decimal', decimalScale: 4 },
      { key: 'weightUnit', kind: 'select', options: WEIGHT_UNITS, defaultValue: 'kg', keepDefault: true },
    ],
  },
  {
    // The org's single shipping configuration row: which ledger accounts
    // carry label cost, which preset fills in missing parcel sizes, and
    // the rate, markup, insurance, signature and customs defaults every
    // shipment starts from. Created once from this page; never deleted.
    key: 'shipping-settings',
    table: 'shipping_settings',
    singularTitleKey: 'entities.shipping-settings.singular',
    rehomed: true,
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'shippingHub',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'created_at',
    hasActive: false,
    allowDelete: false,
    columns: [
      { key: 'shippingExpenseAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'carrierPayableAccountId', kind: 'ref', ref: 'accounts' },
      { key: 'defaultPresetId', kind: 'ref', ref: 'package-presets' },
      { key: 'defaultRateRule', kind: 'badge', options: RATE_RULES },
    ],
    fields: [
      { key: 'shippingExpenseAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'carrierPayableAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'defaultPresetId', kind: 'ref', ref: 'package-presets', helpTextKey: 'fieldHelp.shippingDefaultPreset' },
      { key: 'defaultRateRule', kind: 'select', options: RATE_RULES, defaultValue: 'cheapest', keepDefault: true },
      { key: 'markupBps', kind: 'integer', min: 0, defaultValue: 0, keepDefault: true, helpTextKey: 'fieldHelp.shippingMarkup' },
      { key: 'defaultInsurance', kind: 'select', options: INSURANCE_DEFAULTS, defaultValue: 'none', keepDefault: true },
      { key: 'defaultSignature', kind: 'select', options: SIGNATURE_DEFAULTS, defaultValue: 'none', keepDefault: true },
      { key: 'customsDefaults', kind: 'json', helpTextKey: 'fieldHelp.shippingCustomsDefaults' },
    ],
  },
]
