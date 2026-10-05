/** Setup-registry stored-value program entity (pure descriptor; validation attaches server-side). */
import type { SetupEntity } from '../types'

export const STORED_VALUE_ENTITIES: SetupEntity[] = [
  {
    // Gift card and store credit programs: the liability home, the breakage
    // policy and rate, and expiry. Engine validation (account types, rate
    // bounds, income-account requirements) runs on every write through the
    // shared candidate validator, so Setup saves carry API-grade guarantees.
    key: 'stored-value-programs',
    table: 'stored_value_programs',
    actorCols: true,
    groupKey: 'billing',
    featureKey: 'storedValue',
    iconKey: 'payments',
    orgScoped: true,
    orderBy: 'kind, name',
    hasActive: true,
    writePermission: 'stored_value.manage',
    formDescriptionKey: 'storedValueProgramFields.description',
    formSections: [
      { titleKey: 'storedValueProgramFields.details', fields: ['name', 'kind', 'currency', 'isActive'] },
      { titleKey: 'storedValueProgramFields.liability', fields: ['liabilityAccountId', 'breakageIncomeAccountId'] },
      { titleKey: 'storedValueProgramFields.breakage', fields: ['breakagePolicy', 'breakageRate', 'expiryMonths', 'inactivityMonths'] },
    ],
    columns: [
      { key: 'name', kind: 'text' },
      { key: 'kind', kind: 'text' },
      { key: 'currency', kind: 'code' },
      { key: 'breakagePolicy', labelKey: 'storedValueProgramFields.breakagePolicy', kind: 'text' },
      { key: 'isActive', kind: 'badge-active' },
    ],
    fields: [
      { key: 'name', kind: 'text', required: true },
      {
        key: 'kind', kind: 'select', required: true, lockedOnEdit: true,
        options: [
          { value: 'gift_card', labelKey: 'options.storedValueKind.giftCard' },
          { value: 'store_credit', labelKey: 'options.storedValueKind.storeCredit' },
        ],
      },
      { key: 'currency', kind: 'ref', ref: 'currencies', required: true },
      { key: 'liabilityAccountId', labelKey: 'storedValueProgramFields.liabilityAccount', kind: 'ref', ref: 'accounts', helpTextKey: 'fieldHelp.storedValueLiabilityAccount' },
      { key: 'breakageIncomeAccountId', labelKey: 'storedValueProgramFields.breakageIncomeAccount', kind: 'ref', ref: 'accounts', helpTextKey: 'fieldHelp.storedValueBreakageIncomeAccount' },
      {
        key: 'breakagePolicy', labelKey: 'storedValueProgramFields.breakagePolicy', kind: 'select', required: true, defaultValue: 'none',
        options: [
          { value: 'none', labelKey: 'options.breakagePolicy.none' },
          { value: 'proportional', labelKey: 'options.breakagePolicy.proportional' },
          { value: 'remote', labelKey: 'options.breakagePolicy.remote' },
        ],
        helpTextKey: 'fieldHelp.storedValueBreakagePolicy',
      },
      { key: 'breakageRate', labelKey: 'storedValueProgramFields.breakageRate', kind: 'decimal', decimalScale: 10, defaultValue: '0', helpTextKey: 'fieldHelp.storedValueBreakageRate' },
      { key: 'expiryMonths', labelKey: 'storedValueProgramFields.expiryMonths', kind: 'integer', min: 1, helpTextKey: 'fieldHelp.storedValueExpiryMonths' },
      { key: 'inactivityMonths', labelKey: 'storedValueProgramFields.inactivityMonths', kind: 'integer', required: true, min: 1, defaultValue: 24, helpTextKey: 'fieldHelp.storedValueInactivityMonths' },
      { key: 'isActive', kind: 'boolean', defaultValue: true, booleanStyle: 'switch', fullWidth: true },
    ],
    filters: [
      {
        key: 'kind',
        options: [
          { value: 'gift_card', labelKey: 'options.storedValueKind.giftCard' },
          { value: 'store_credit', labelKey: 'options.storedValueKind.storeCredit' },
        ],
      },
    ],
  },
]
