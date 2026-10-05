/**
 * Promotion and restocking-fee setup validation. Server-only: it runs the
 * engine's sales rules inside the setup write path and is attached by
 * entity key, so the entity declarations stay safe for the client registry.
 */
import 'server-only'
import { sql } from 'drizzle-orm'
import {
  PromotionRefusal,
  promotionStatusTransition,
  validatePromotionFields,
  type PromotionStatus,
} from '@openbooks/engine/sales/promotions'
import {
  checkRestockingPolicyOverlap,
  RestockingFeeRefusal,
  validateRestockingFeePolicy,
} from '@openbooks/engine/sales/restocking-fees'
import type { SetupEntityValidationHook } from './types'

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

export const validatePromotionWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
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

export const validateRestockingFeeWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
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
      // Form values arrive untyped; the engine validator refines and refuses
      // anything unusable, so these casts only satisfy the compiler.
      itemCategory: merged.itemCategory as string | null,
      itemId: merged.itemId as string | null,
      kind: merged.kind as 'percent' | 'fixed',
      feePercent: merged.feePercent as string | null,
      feeAmountMinor: merged.feeAmountMinor as string | null,
      currency: merged.currency as string | null,
      effectiveTo: merged.effectiveTo as string | null,
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
