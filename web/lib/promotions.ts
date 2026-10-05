/** Promotion application from document drawers: list active codes, apply one. */
import 'server-only'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import {
  applyPromotion,
  listPromotions,
  type ApplyPromotionResult,
  type Promotion,
} from '@openbooks/engine/src/sales/promotions.ts'

export async function listActivePromotions(orgId: string): Promise<Promotion[]> {
  return listPromotions(db, orgId, true)
}

export async function applyDocumentPromotion(input: {
  orgId: string
  actorId: string
  documentId: string
  code?: string
  promotionId?: string
  channelId?: string | null
  allowedSubsidiaryIds: ReadonlySet<string> | null
}): Promise<ApplyPromotionResult> {
  return withOrgTransaction(input.orgId, () =>
    applyPromotion(db, input.orgId, input.actorId, {
      documentId: input.documentId,
      code: input.code,
      promotionId: input.promotionId,
      channelId: input.channelId,
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
    }),
  )
}
