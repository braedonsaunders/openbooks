import type { SetupCreateChoice, SetupEntity, SetupField } from '../types'

/** Internal billing methods, in the order the create chooser offers them. */
export const INTERNAL_BILLING_METHOD_KEYS = ['revenue_credit', 'cost_transfer', 'intercompany_sale'] as const
export type InternalBillingMethodKey = (typeof INTERNAL_BILLING_METHOD_KEYS)[number]

const label = (key: string) => `internalBilling.${key}`
const field = (key: string, kind: SetupField['kind'], extra: Partial<SetupField> = {}): SetupField =>
  ({ key, kind, labelKey: label(`fields.${key}`), ...extra })

/** Revenue and cost accounts: the server holds each side to its method's types. */
const PROFIT_AND_LOSS_TYPES = ['income', 'income_other', 'cogs', 'expense', 'expense_other'] as const

/**
 * Internal billing rules (effective-dated versions). Writes go through the
 * internal billing rule endpoint, which validates the method's account
 * types, closes the prior version's window and records the reason. A
 * version's method, accounts and start date never change: a new treatment
 * is a new version. The setup page supplies the create chooser with the
 * organization's suggested accounts for each method.
 */
export const INTERNAL_BILLING_RULES_ENTITY: SetupEntity = {
  key: 'internal-billing',
  table: 'internal_billing_rules',
  groupKey: 'accounting',
  featureKey: 'internalBilling',
  iconKey: 'receipt',
  orgScoped: true,
  actorCols: true,
  orderBy: 'code, effective_from desc',
  hasActive: true,
  allowDelete: false,
  importVia: 'none',
  singularTitleKey: 'entities.internal-billing.singularTitle',
  drawerSize: 'xl',
  mutationPath: '/api/internal-billing/rules',
  mutationCreateKeys: ['code', 'name', 'method', 'debitAccountId', 'creditAccountId', 'billableByDefault', 'description', 'effectiveFrom', 'effectiveTo', 'reason'],
  mutationUpdateKeys: ['name', 'description', 'billableByDefault', 'effectiveTo', 'isActive', 'reason'],
  formDescriptionKey: label('formDescription'),
  formSections: [
    { titleKey: label('sections.rule'), fields: ['code', 'name', 'method', 'description'] },
    { titleKey: label('sections.advanced'), descriptionKey: label('sections.advancedHelp'), fields: ['debitAccountId', 'creditAccountId', 'effectiveFrom', 'effectiveTo', 'billableByDefault', 'isActive'] },
    { titleKey: label('sections.reason'), fields: ['reason'] },
  ],
  columns: [
    { key: 'code', kind: 'code', labelKey: label('fields.code') },
    { key: 'name', kind: 'text', labelKey: label('fields.name') },
    { key: 'method', kind: 'badge', labelKey: label('fields.method'), options: INTERNAL_BILLING_METHOD_KEYS.map((value) => ({ value, labelKey: label(`methods.${value}.label`) })) },
    { key: 'effectiveFrom', kind: 'date', labelKey: label('fields.effectiveFrom') },
    { key: 'effectiveTo', kind: 'date', labelKey: label('fields.effectiveTo') },
    { key: 'isActive', kind: 'badge-active', labelKey: label('fields.isActive') },
  ],
  filters: [{ key: 'method', options: INTERNAL_BILLING_METHOD_KEYS.map((value) => ({ value, labelKey: label(`methods.${value}.label`) })) }],
  fields: [
    field('code', 'text', { required: true, lockedOnEdit: true, helpTextKey: label('help.code') }),
    field('name', 'text', { required: true }),
    field('method', 'select', {
      required: true,
      lockedOnEdit: true,
      options: INTERNAL_BILLING_METHOD_KEYS.map((value) => ({ value, labelKey: label(`methods.${value}.label`) })),
    }),
    field('description', 'textarea', { fullWidth: true }),
    field('debitAccountId', 'ref', { ref: 'accounts', required: true, lockedOnEdit: true, refAccountTypes: PROFIT_AND_LOSS_TYPES, helpTextKey: label('help.debitAccountId') }),
    field('creditAccountId', 'ref', { ref: 'accounts', required: true, lockedOnEdit: true, refAccountTypes: PROFIT_AND_LOSS_TYPES, helpTextKey: label('help.creditAccountId') }),
    field('effectiveFrom', 'date', { required: true, lockedOnEdit: true }),
    field('effectiveTo', 'date', { helpTextKey: label('help.effectiveTo') }),
    field('billableByDefault', 'boolean', {
      booleanStyle: 'switch',
      showWhen: { field: 'method', in: ['cost_transfer', 'intercompany_sale'] },
      clearWhenHidden: false,
      defaultValue: false,
      helpTextKey: label('help.billableByDefault'),
    }),
    field('isActive', 'boolean', { booleanStyle: 'switch', defaultValue: true, helpTextKey: label('help.isActive') }),
    field('reason', 'textarea', { required: true, fullWidth: true, resetOnEdit: true, helpTextKey: label('help.reason') }),
  ],
}

/**
 * The three create cards. `accounts` pre-selects the organization's
 * suggested accounts per method; the operator confirms them under Advanced.
 */
export function internalBillingCreateChooser(
  today: string,
  accounts: Record<InternalBillingMethodKey, { debitAccountId: string | null; creditAccountId: string | null }>,
): NonNullable<SetupEntity['createChooser']> {
  const icons: Record<InternalBillingMethodKey, string> = { revenue_credit: 'hand-coins', cost_transfer: 'receipt', intercompany_sale: 'building' }
  const options: SetupCreateChoice[] = INTERNAL_BILLING_METHOD_KEYS.map((method) => ({
    key: method,
    iconKey: icons[method],
    labelKey: label(`methods.${method}.label`),
    descriptionKey: label(`methods.${method}.description`),
    values: {
      method,
      effectiveFrom: today,
      billableByDefault: false,
      isActive: true,
      ...(accounts[method].debitAccountId ? { debitAccountId: accounts[method].debitAccountId } : {}),
      ...(accounts[method].creditAccountId ? { creditAccountId: accounts[method].creditAccountId } : {}),
    },
  }))
  return { titleKey: label('chooser.title'), descriptionKey: label('chooser.description'), options }
}
