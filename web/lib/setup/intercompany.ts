/** Setup-registry intercompany entities: representing parties and transfer pricing. */
import type { SetupEntity, SetupEntityValidationHook } from './types'

export const TRANSFER_PRICING_METHODS = [
  { value: 'price_level', labelKey: 'options.transferPricingMethod.price_level' },
  { value: 'cost_plus', labelKey: 'options.transferPricingMethod.cost_plus' },
]

/**
 * The representation is validated against its subject before the storage
 * guard: the parties hold the matching active role, neither already trades
 * with the entity it represents, and each represents only this entity. The
 * hook loads the engine lazily because this module rides the client
 * registry bundle; it only ever runs inside the server write path.
 */
const validateRepresentingPartiesWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const { representingPartiesRefusal } = await import('@openbooks/engine/intercompany')
  const current = rowId
    ? (await executor.execute<Record<string, unknown>>(sql`
        select subsidiary_id, customer_party_id, vendor_party_id, is_active
          from intercompany_representing_parties where org_id = ${orgId} and id = ${rowId}`)).rows[0] ?? null
    : null
  return representingPartiesRefusal(executor, orgId, body, current, rowId ?? null)
}

const validateTransferPricingWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const { sql } = await import('drizzle-orm')
  const { transferPricingPolicySetupRefusal } = await import('@openbooks/engine/intercompany')
  const current = rowId
    ? (await executor.execute<Record<string, unknown>>(sql`
        select seller_subsidiary_id, buyer_subsidiary_id, method, price_level_id, markup_percent::text as markup_percent,
               revenue_account_id, cost_account_id, effective_from::text as effective_from, effective_to::text as effective_to
          from intercompany_transfer_pricing_policies where org_id = ${orgId} and id = ${rowId}`)).rows[0] ?? null
    : null
  return transferPricingPolicySetupRefusal(executor, orgId, body, current)
}

/**
 * The customer and vendor that represent a subsidiary to its sister
 * entities. A sale to the representing customer, or a purchase from the
 * representing vendor, is intercompany: it posts through the intercompany
 * pair's receivable or payable account, is eliminated in consolidation and
 * appears in pairing and reconciliation. Representations are retired, not
 * deleted, so history keeps its meaning.
 */
export const INTERCOMPANY_REPRESENTING_PARTIES_ENTITY: SetupEntity = {
  key: 'intercompany-representing-parties',
  table: 'intercompany_representing_parties',
  actorCols: true,
  groupKey: 'accounting',
  iconKey: 'users',
  featureKey: 'intercompanyTransactions',
  orgScoped: true,
  orderBy: 'created_at',
  hasActive: true,
  allowDelete: false,
  docSlug: 'intercompany',
  validateWrite: validateRepresentingPartiesWrite,
  columns: [
    { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
    { key: 'customerPartyId', kind: 'ref', ref: 'customers' },
    { key: 'vendorPartyId', kind: 'ref', ref: 'vendors' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true, lockedOnEdit: true, helpTextKey: 'fieldHelp.representedSubsidiary' },
    { key: 'customerPartyId', kind: 'ref', ref: 'customers', searchableReferences: true, helpTextKey: 'fieldHelp.representingCustomer' },
    { key: 'vendorPartyId', kind: 'ref', ref: 'vendors', searchableReferences: true, helpTextKey: 'fieldHelp.representingVendor' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}

/**
 * Effective-dated transfer prices a selling entity charges sister entities:
 * a price level's prices or cost plus a markup, with the eliminated revenue
 * and cost accounts the intercompany cross-charge posts to. A policy that has
 * priced a charge keeps its terms; to change a price, end the policy and add
 * a new one from the change date.
 */
export const INTERCOMPANY_TRANSFER_PRICING_ENTITY: SetupEntity = {
  key: 'intercompany-transfer-pricing',
  table: 'intercompany_transfer_pricing_policies',
  actorCols: true,
  groupKey: 'accounting',
  iconKey: 'percent',
  featureKey: 'intercompanyTransactions',
  orgScoped: true,
  naturalKey: 'code',
  orderBy: 'seller_subsidiary_id, effective_from desc',
  hasActive: true,
  docSlug: 'intercompany',
  validateWrite: validateTransferPricingWrite,
  columns: [
    { key: 'code', kind: 'code' },
    { key: 'name', kind: 'text' },
    { key: 'sellerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
    { key: 'buyerSubsidiaryId', kind: 'ref', ref: 'subsidiaries' },
    { key: 'method', kind: 'badge', options: TRANSFER_PRICING_METHODS },
    { key: 'effectiveFrom', kind: 'date' },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'isActive', kind: 'badge-active' },
  ],
  fields: [
    { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
    { key: 'name', kind: 'text', required: true },
    { key: 'sellerSubsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true, helpTextKey: 'fieldHelp.transferPricingSeller' },
    { key: 'buyerSubsidiaryId', kind: 'ref', ref: 'subsidiaries', helpTextKey: 'fieldHelp.transferPricingBuyer' },
    { key: 'method', kind: 'select', options: TRANSFER_PRICING_METHODS, required: true },
    { key: 'priceLevelId', kind: 'ref', ref: 'price-levels', showWhen: { field: 'method', in: ['price_level'] }, clearWhenHidden: true },
    { key: 'markupPercent', kind: 'decimal', decimalScale: 4, showWhen: { field: 'method', in: ['cost_plus'] }, clearWhenHidden: true, helpTextKey: 'fieldHelp.transferPricingMarkup' },
    { key: 'revenueAccountId', kind: 'ref', ref: 'accounts', required: true, refAccountTypes: ['income', 'income_other'], helpTextKey: 'fieldHelp.transferPricingRevenue' },
    { key: 'costAccountId', kind: 'ref', ref: 'accounts', required: true, refAccountTypes: ['cogs', 'expense', 'expense_other'], helpTextKey: 'fieldHelp.transferPricingCost' },
    { key: 'effectiveFrom', kind: 'date', required: true },
    { key: 'effectiveTo', kind: 'date' },
    { key: 'description', kind: 'textarea' },
    { key: 'isActive', kind: 'boolean', defaultValue: true },
  ],
}
