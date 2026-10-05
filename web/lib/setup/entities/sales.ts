/** Setup-registry sales entities: promotions and restocking fee policies. */
import 'server-only'
import { sql } from 'drizzle-orm'
import {
  PromotionRefusal,
  promotionStatusTransition,
  validatePromotionFields,
  type PromotionStatus,
} from '@openbooks/engine/src/sales/promotions.ts'
import {
  checkRestockingPolicyOverlap,
  RestockingFeeRefusal,
  validateRestockingFeePolicy,
} from '@openbooks/engine/src/sales/restocking-fees.ts'
import type { SetupEntity, SetupEntityValidationHook } from '../types'

type CurrentPromotion = {
  code: string
  name: string
  description: string | null
  kind: string
  status: string
  percent_value: string | null
  amount_minor: string | null
  currency: string | null
  buy_quantity: number | null
  get_quantity: number | null
  starts_at: string | null
  ends_at: string | null
  usage_limit: number | null
  discount_account_id: string | null
}

const validatePromotionWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<CurrentPromotion>(sql`
        select code, name, description, kind, status, percent_value::text, amount_minor::text,
               currency, buy_quantity, get_quantity, starts_at::text as starts_at, ends_at::text as ends_at,
               usage_limit, discount_account_id
          from promotions where id = ${rowId} and org_id = ${orgId}`)).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const value = <T>(key: string, fallback: T): T =>
    (body[key] === undefined ? fallback : body[key] === null || body[key] === '' ? null as unknown as T : body[key] as T)
  try {
    validatePromotionFields({
      code: String(body.code ?? current?.code ?? ''),
      name: String(body.name ?? current?.name ?? ''),
      description: (body.description ?? current?.description ?? null) as string | null,
      kind: String(body.kind ?? current?.kind ?? '') as 'percent' | 'amount' | 'free_shipping' | 'buy_x_get_y',
      percentValue: value('percentValue', current?.percent_value) as string | null,
      amountMinor: value('amountMinor', current?.amount_minor) as string | null,
      currency: value('currency', current?.currency) as string | null,
      buyQuantity: value('buyQuantity', current?.buy_quantity) as number | null,
      getQuantity: value('getQuantity', current?.get_quantity) as number | null,
      startsAt: value('startsAt', current?.starts_at) as string | null,
      endsAt: value('endsAt', current?.ends_at) as string | null,
      usageLimit: value('usageLimit', current?.usage_limit) as number | null,
      discountAccountId: value('discountAccountId', current?.discount_account_id) as string | null,
    })
  } catch (error) {
    if (error instanceof PromotionRefusal) return error.message
    throw error
  }
  const nextStatus = body.status === undefined ? current?.status : String(body.status)
  if (nextStatus && nextStatus !== current?.status) {
    const remedy = promotionStatusTransition((current?.status ?? 'draft') as PromotionStatus, nextStatus as PromotionStatus)
    if (remedy !== null) return remedy
  }
}

type CurrentFeePolicy = {
  item_category: string | null
  item_id: string | null
  kind: string
  fee_percent: string | null
  fee_amount_minor: string | null
  currency: string | null
  income_account_id: string
  effective_from: string
  effective_to: string | null
}

const validateRestockingFeeWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<CurrentFeePolicy>(sql`
        select item_category, item_id, kind, fee_percent::text, fee_amount_minor::text, currency,
               income_account_id, effective_from::text, effective_to::text
          from restocking_fee_policies where id = ${rowId} and org_id = ${orgId}`)).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const merged = {
    itemCategory: body.itemCategory === undefined ? current?.item_category ?? null : body.itemCategory || null,
    itemId: body.itemId === undefined ? current?.item_id ?? null : body.itemId || null,
    kind: String(body.kind ?? current?.kind ?? ''),
    feePercent: body.feePercent === undefined ? current?.fee_percent : body.feePercent || null,
    feeAmountMinor: body.feeAmountMinor === undefined ? current?.fee_amount_minor : body.feeAmountMinor || null,
    currency: body.currency === undefined ? current?.currency ?? null : body.currency || null,
    incomeAccountId: String(body.incomeAccountId ?? current?.income_account_id ?? ''),
    effectiveFrom: String(body.effectiveFrom ?? current?.effective_from ?? ''),
    effectiveTo: body.effectiveTo === undefined ? current?.effective_to ?? null : body.effectiveTo || null,
  }
  try {
    validateRestockingFeePolicy({
      ...merged,
      kind: merged.kind as 'percent' | 'fixed',
      waivable: body.waivable === undefined ? undefined : Boolean(body.waivable),
    })
    // One open policy per scope, serialized with the write transaction.
    await checkRestockingPolicyOverlap(executor, orgId, {
      itemCategory: merged.itemCategory as string | null,
      itemId: merged.itemId as string | null,
      effectiveFrom: merged.effectiveFrom,
      effectiveTo: merged.effectiveTo as string | null,
      ignoreId: rowId ?? null,
    })
  } catch (error) {
    if (error instanceof RestockingFeeRefusal) return error.message
    throw error
  }
}

const PROMOTION_KIND_OPTIONS = [
  { value: 'percent', labelKey: 'options.promotionKind.percent' },
  { value: 'amount', labelKey: 'options.promotionKind.amount' },
  { value: 'free_shipping', labelKey: 'options.promotionKind.free_shipping' },
  { value: 'buy_x_get_y', labelKey: 'options.promotionKind.buy_x_get_y' },
] as const

const PROMOTION_STATUS_OPTIONS = [
  { value: 'draft', labelKey: 'options.promotionStatus.draft' },
  { value: 'active', labelKey: 'options.promotionStatus.active' },
  { value: 'archived', labelKey: 'options.promotionStatus.archived' },
] as const

const RESTOCKING_FEE_KIND_OPTIONS = [
  { value: 'percent', labelKey: 'options.restockingFeeKind.percent' },
  { value: 'fixed', labelKey: 'options.restockingFeeKind.fixed' },
] as const

export const SALES_SETUP_ENTITIES: SetupEntity[] = [
  {
    key: 'promotions',
    table: 'promotions',
    singularTitleKey: 'entities.promotions.singular',
    actorCols: true,
    groupKey: 'sales',
    featureKey: 'promotions',
    writePermission: 'documents.manage',
    iconKey: 'tag',
    orgScoped: true,
    naturalKey: 'code',
    orderBy: 'code',
    hasActive: false,
    // Discount lines and redemptions reference a promotion: history is
    // archived through the status, never deleted.
    allowDelete: false,
    columns: [
      { key: 'code', kind: 'code' },
      { key: 'name', kind: 'text' },
      { key: 'kind', kind: 'badge', options: [...PROMOTION_KIND_OPTIONS] },
      { key: 'status', kind: 'badge', options: [...PROMOTION_STATUS_OPTIONS] },
      { key: 'usageCount', kind: 'number' },
    ],
    fields: [
      { key: 'code', kind: 'text', required: true, lockedOnEdit: true },
      { key: 'name', kind: 'text', required: true },
      { key: 'description', kind: 'textarea' },
      { key: 'kind', kind: 'select', required: true, options: [...PROMOTION_KIND_OPTIONS] },
      { key: 'status', kind: 'select', defaultValue: 'draft', options: [...PROMOTION_STATUS_OPTIONS] },
      { key: 'percentValue', kind: 'percent', decimalScale: 4, min: 0, max: 100, showWhen: { field: 'kind', in: ['percent'] } },
      { key: 'amountMinor', kind: 'integer', min: 1, showWhen: { field: 'kind', in: ['amount'] }, helpTextKey: 'fieldHelp.minorAmount' },
      { key: 'currency', kind: 'ref', ref: 'currencies', showWhen: { field: 'kind', in: ['amount'] } },
      { key: 'buyQuantity', kind: 'integer', min: 1, showWhen: { field: 'kind', in: ['buy_x_get_y'] } },
      { key: 'getQuantity', kind: 'integer', min: 1, showWhen: { field: 'kind', in: ['buy_x_get_y'] } },
      { key: 'discountAccountId', kind: 'ref', ref: 'accounts', showWhen: { field: 'kind', in: ['percent', 'amount', 'buy_x_get_y'] } },
      { key: 'startsAt', kind: 'date' },
      { key: 'endsAt', kind: 'date' },
      { key: 'usageLimit', kind: 'integer', min: 1 },
    ],
    validateWrite: validatePromotionWrite,
  },
  {
    key: 'restocking-fee-policies',
    table: 'restocking_fee_policies',
    singularTitleKey: 'entities.restocking-fee-policies.singular',
    actorCols: true,
    groupKey: 'inventory',
    featureKey: 'returnAuthorizations',
    writePermission: 'documents.manage',
    iconKey: 'package',
    orgScoped: true,
    orderBy: 'effective_from',
    hasActive: false,
    columns: [
      { key: 'kind', kind: 'badge' },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'itemCategory', kind: 'text' },
      { key: 'effectiveFrom', kind: 'date' },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'waivable', kind: 'badge' },
    ],
    fields: [
      { key: 'kind', kind: 'select', required: true, options: [...RESTOCKING_FEE_KIND_OPTIONS] },
      { key: 'itemId', kind: 'ref', ref: 'items' },
      { key: 'itemCategory', kind: 'text' },
      { key: 'feePercent', kind: 'percent', decimalScale: 4, min: 0, max: 100, showWhen: { field: 'kind', in: ['percent'] } },
      { key: 'feeAmountMinor', kind: 'integer', min: 1, showWhen: { field: 'kind', in: ['fixed'] }, helpTextKey: 'fieldHelp.minorAmount' },
      { key: 'currency', kind: 'ref', ref: 'currencies', showWhen: { field: 'kind', in: ['fixed'] } },
      { key: 'incomeAccountId', kind: 'ref', ref: 'accounts', required: true },
      { key: 'effectiveFrom', kind: 'date', required: true },
      { key: 'effectiveTo', kind: 'date' },
      { key: 'waivable', kind: 'boolean', defaultValue: true, booleanStyle: 'switch', fullWidth: true },
    ],
    validateWrite: validateRestockingFeeWrite,
  },
]
