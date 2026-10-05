import 'server-only'

import { sql } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { dateLabel } from '../../../../../lib/format'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid, mergeHref, pickString } from '../../../../../lib/list-params'
import { getMoneyFormatter } from '@/lib/money-server'
import type { ReviewDrawerData } from './ReviewDrawer'

/**
 * Refund and dispute review queue, split into a loader and a spec.
 *
 * The queue itself is the universal entity list over the automation ledger
 * (`payment_dispute_review`); the spec places the row drawer, which the
 * loader resolves to the selected review with its linked receipt or invoice
 * numbers, status history and the operator's decision grant. Approving posts
 * through the automatic path, rejecting moves nothing — both through the
 * review endpoint, never from the list itself.
 */

export interface PspReviewsData {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  currentParams: Record<string, string | string[] | undefined>
  drawer: ReviewDrawerData | null
}

interface DisputeRow extends Record<string, unknown> {
  id: string
  provider: string
  kind: string
  status: string
  currency: string
  amount: string
  providerEventId: string
  providerRef: string | null
  reason: string | null
  receiptNumber: string | null
  invoiceNumber: string | null
  statusHistory: unknown
}

const REVIEW_STATUSES = ['pending_review', 'posted', 'rejected', 'opened', 'won', 'lost'] as const

export async function loadPspReviews(
  sp?: Record<string, string | string[] | undefined>,
): Promise<PspReviewsData> {
  // The house refusal names banking.read: a reader without it sees
  // /access-denied, never a silent bounce home.
  const authz = await requirePermission('banking.read')
  await requireFeatureEnabled(authz.user.orgId, 'banking')
  const t = await getTranslations('banking.pspReviews')
  const settlementT = await getTranslations('banking.pspSettlements')
  const common = await getTranslations('common')
  const locale = await getLocale()
  const { money } = await getMoneyFormatter()
  const params = sp ?? {}

  let drawer: ReviewDrawerData | null = null
  const selected = pickString(params.review)
  if (selected) {
    if (!isUuid(selected)) notFound()
    const row = (
      await db.execute<DisputeRow>(sql`
        select pd.id, pd.provider, pd.kind, pd.status, pd.currency, pd.amount::text as amount,
               pd.provider_event_id as "providerEventId", pd.provider_ref as "providerRef",
               pd.reason, r.document_number as "receiptNumber", i.document_number as "invoiceNumber",
               pd.status_history as "statusHistory"
          from payment_disputes pd
          left join documents r
            on r.org_id = pd.org_id and r.id = pd.receipt_document_id
          left join documents i
            on i.org_id = pd.org_id and i.id = pd.invoice_document_id
         where pd.org_id = ${authz.user.orgId} and pd.id = ${selected}
         limit 1
      `)
    ).rows[0]
    // Another tenant's review reads as missing, never as a foreign refusal.
    if (!row) notFound()
    const status = REVIEW_STATUSES.includes(row.status as (typeof REVIEW_STATUSES)[number])
      ? (row.status as (typeof REVIEW_STATUSES)[number])
      : 'pending_review'
    const history = Array.isArray(row.statusHistory)
      ? row.statusHistory.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const item = entry as { status?: unknown; at?: unknown; reason?: unknown }
          const itemStatus = typeof item.status === 'string' ? item.status : 'pending_review'
          const at = typeof item.at === 'string' ? item.at.slice(0, 10) : ''
          return [
            {
              status: itemStatus,
              statusLabel: t(`status.${itemStatus}`),
              at: at ? dateLabel(new Date(`${at}T12:00:00Z`), locale) : at,
              reason: typeof item.reason === 'string' ? item.reason : null,
            },
          ]
        })
      : []
    drawer = {
      id: String(row.id),
      providerLabel: settlementT(`providers.${row.provider}`),
      kindLabel: t(`kind.${row.kind}`),
      statusLabel: t(`status.${status}`),
      isPending: row.status === 'pending_review',
      amount: money(String(row.amount), { currency: String(row.currency) }),
      providerEventId: String(row.providerEventId),
      providerRef: row.providerRef,
      reason: row.reason,
      receiptNumber: row.receiptNumber,
      invoiceNumber: row.invoiceNumber,
      history,
      // Resolving a parked review moves or refuses money, so the drawer owns
      // no decision without banking.reconcile — a reader still sees the row.
      canDecide: can(authz, 'banking.reconcile'),
      closeHref: mergeHref('/banking/psp-settlements/reviews', params, { review: undefined }),
      strings: {
        kindRow: t('drawerKind'),
        statusRow: common('labels.status'),
        amountRow: common('labels.amount'),
        eventRow: t('drawerEvent'),
        providerRefRow: t('drawerProviderRef'),
        reasonGivenRow: t('drawerReason'),
        receiptRow: t('drawerReceipt'),
        invoiceRow: t('drawerInvoice'),
        historyTitle: t('drawerHistory'),
        approveLabel: t('approve'),
        rejectLabel: t('reject'),
        reasonLabel: t('reasonLabel'),
        reasonPlaceholder: t('reasonPlaceholder'),
        decidedNote: t('decidedNote'),
        approvedMessage: t('approvedMessage'),
        rejectedMessage: t('rejectedMessage'),
        closeLabel: common('actions.close'),
      },
    }
  }

  return {
    title: t('title'),
    description: t('description'),
    emptyTitle: t('emptyTitle'),
    emptyDescription: t('emptyDescription'),
    currentParams: params,
    drawer,
  }
}

const f = ref<PspReviewsData>()

export function pspReviewsSpec(data: PspReviewsData): PageSpec {
  return page({
    route: '/banking/psp-settlements/reviews',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      // No `when`: the queue always renders. The drawer arrives as null when
      // closed and its slot renders nothing; the list renders the drawer
      // itself after the table, the same arrangement the document lists use.
      widgetBlock('entity-list-view', {
        recordType: 'payment_dispute_review',
        sp: data.currentParams,
        drawer: data.drawer ? { widget: 'psp-dispute-review-drawer', props: { review: data.drawer } } : null,
        emptyAction: null,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
      }),
    ],
  })
}
