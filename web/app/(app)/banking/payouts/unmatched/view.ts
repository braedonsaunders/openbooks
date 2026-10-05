import 'server-only'

import { sql } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/platform/database'
import { page, pageHeader, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid, pickString } from '../../../../../lib/list-params'
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { getMoneyFormatter } from '@/lib/money-server'
import type { PayoutLineDrawerData } from './PayoutLineDrawer'

/**
 * Unmatched payout lines: the needs-attention queue behind the payouts
 * console. The console shows the first page as a cockpit snapshot; this
 * list is the full queue with search, kind/provider filters and sorting.
 * Each row carries the proposal chip; the drawer proposes the native
 * document with evidence and links it on approval. Nothing links itself.
 */

export interface PspUnmatchedData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  emptyTitle: string
  emptyDescription: string
  drawer: { widget: string; props: { line: PayoutLineDrawerData } } | null
}

interface UnmatchedLineRow extends Record<string, unknown> {
  id: string
  provider: string
  kind: string
  externalRef: string | null
  description: string | null
  amount: string
  currency: string | null
  batchCurrency: string | null
  batchRef: string
  settlementDate: string
}

export async function loadPspUnmatched(
  sp?: Record<string, string | string[] | undefined>,
): Promise<PspUnmatchedData> {
  const authz = await requirePermission('banking.read')
  await requireFeatureEnabled(authz.user.orgId, 'banking')
  const t = await getTranslations('banking.pspUnmatched')
  const settlementT = await getTranslations('banking.pspSettlements')
  const payoutsT = await getTranslations('banking.payouts')
  const { money } = await getMoneyFormatter()
  const params = sp ?? {}

  let drawer: PspUnmatchedData['drawer'] = null
  const selected = pickString(params.line)
  if (selected) {
    if (!isUuid(selected)) notFound()
    // The drawer reads the same entity scope as the queue: a line on a
    // payout the caller may not see reads as missing, with its amount and
    // reference. An unknown scope reads nothing.
    const scope = authz.allowedSubsidiaryIds === undefined ? new Set<string>() : authz.allowedSubsidiaryIds
    const row = (
      await db.execute<UnmatchedLineRow>(sql`
        select l.id, b.provider, l.kind, l.external_ref as "externalRef", l.description,
               l.amount::text as amount, l.currency, b.currency as "batchCurrency",
               b.external_ref as "batchRef", b.settlement_date::text as "settlementDate"
          from psp_settlement_lines l
          join psp_settlement_batches b on b.org_id = l.org_id and b.id = l.batch_id
         where l.org_id = ${authz.user.orgId} and l.id = ${selected} and l.document_id is null
           ${subsidiaryVisibleFilter(sql`b.subsidiary_id`, scope)}
         limit 1
      `)
    ).rows[0]
    // Another tenant's line — or one linked since — reads as missing, never
    // as a foreign refusal.
    if (!row) notFound()
    // Every shipped locale names every matchable kind; parity enforces it.
    const kindLabel = payoutsT(`kindLabels.${row.kind}`)
    // The amount prices in the record's own currency — the line's, else its
    // payout's — never a fallback. A line with no usable currency omits its
    // amount row instead of showing a converted fiction.
    const currency = (row.currency ?? row.batchCurrency ?? '').trim()
    drawer = {
      widget: 'psp-settlement-line-drawer',
      props: {
        line: {
          id: String(row.id),
          providerLabel: settlementT(`providers.${row.provider}`),
          kindLabel: kindLabel === `lineKind.${row.kind}` ? String(row.kind) : kindLabel,
          amount: currency === '' ? null : money(String(row.amount), { currency }),
          externalRef: row.externalRef,
          description: row.description,
          batchRef: String(row.batchRef),
          settledDate: String(row.settlementDate),
          // Linking moves money; a reader still sees the row and its
          // proposal without the reconcile grant.
          canDecide: can(authz, 'banking.reconcile'),
          strings: {
            kindRow: t('drawer.kindRow'),
            amountRow: t('drawer.amountRow'),
            referenceRow: t('drawer.referenceRow'),
            descriptionRow: t('drawer.descriptionRow'),
            batchRow: t('drawer.batchRow'),
            settledRow: t('drawer.settledRow'),
            proposalTitle: t('assistance.title'),
            proposalLoading: t('assistance.loading'),
            proposalFailed: t('assistance.loadFailed'),
            evidenceTitle: t('assistance.evidence'),
            applyLabel: t('assistance.apply'),
            confirmTitle: t('assistance.confirmTitle'),
          },
        },
      },
    }
  }

  return {
    title: t('title'),
    description: t('description'),
    currentParams: params,
    emptyTitle: t('emptyTitle'),
    emptyDescription: t('emptyDescription'),
    drawer,
  }
}

export function pspUnmatchedSpec(data: PspUnmatchedData): PageSpec {
  return page({
    route: '/banking/payouts/unmatched',
    layout: 'list',
    header: [
      pageHeader({
        title: data.title,
        description: data.description,
      }),
    ],
    body: [
      widgetBlock('entity-list-view', {
        recordType: 'psp_settlement_line_unmatched',
        sp: data.currentParams,
        emptyTitle: data.emptyTitle,
        emptyDescription: data.emptyDescription,
        drawer: data.drawer,
      }),
    ],
  })
}
