import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/platform/database'
import { page, pageHeader, grid, statTile, widgetBlock, ref, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { getMoneyFormatter } from '@/lib/money-server'

/**
 * Banking → Payouts workspace, split into a loader and a spec.
 *
 * The loader resolves the read model only: three cockpit tiles
 * (unreconciled payouts, unmatched lines, in-transit accruals), the
 * needs-attention queue of unmatched lines, and the recent payout batches
 * with their match and tie flags. Matching, linking, adjustment and accrual
 * stay inside the console component (API calls + toasts), exactly where the
 * settlements workspace keeps its mutations. The payout drawer opens from
 * the `payout` URL parameter and fetches its own detail, so one shell
 * covers loading, refusal and retry.
 */

export interface PayoutTile {
  label: string
  value: string
  sub: string
}

export type PayoutQueueRow = {
  lineId: string
  batchId: string
  provider: string
  externalRef: string
  settlementDate: string
  kind: string
  amount: string
  currency: string
}

export interface PayoutBatchRow {
  id: string
  provider: string
  externalRef: string
  settlementDate: string
  currency: string
  netAmount: string
  status: string
  statusLabel: string
  unmatchedLines: number
  tied: boolean
  accrued: boolean
}

export interface PayoutsStrings {
  queueTitle: string
  queueEmpty: string
  batchesTitle: string
  batchesEmpty: string
  reportLinkLabel: string
  matchLabel: string
  linkLabel: string
  unlinkLabel: string
  adjustLabel: string
  accrueLabel: string
  closeLabel: string
  retryLabel: string
  loadingLabel: string
  loadFailedLabel: string
  resolvePlaceholder: string
  matchedToast: string
  linkedToast: string
  unlinkedToast: string
  adjustedToast: string
  accruedToast: string
  adjustConfirmTitle: string
  adjustConfirmMessage: string
  accrueConfirmMessage: string
  accrueResultMessage: string
  drawerTitle: string
  tiedLabel: string
  untiedLabel: string
  untiedHint: string
  gapLabel: string
  accrualTitle: string
  lineHead: string
  kindHead: string
  amountHead: string
  documentHead: string
  matchHead: string
  actionHead: string
  payoutHead: string
  dateHead: string
  netHead: string
  statusHead: string
  unmatchedHead: string
  depositHead: string
  reviewLabel: string
  openLabel: string
  inTransitBadge: string
  accrueTitle: string
  accrueSummary: string
  accrualDateLabel: string
  accrueHint: string
  workingLabel: string
  matchedLabel: string
  unmatchedRowLabel: string
  notApplicableLabel: string
  kindLabels: Record<string, string>
  reasonLabels: Record<string, string>
}

export interface PayoutsData {
  title: string
  description: string
  emptyTitle: string
  emptyDescription: string
  canReconcile: boolean
  tiles: [PayoutTile, PayoutTile, PayoutTile]
  queue: PayoutQueueRow[]
  batches: PayoutBatchRow[]
  reportHref: string
  strings: PayoutsStrings
}

export async function loadPayouts(
  _sp?: Record<string, string | string[] | undefined>,
): Promise<PayoutsData> {
  // The house refusal names banking.read: a reader without it sees
  // /access-denied, never a silent bounce home.
  const authz = await requirePermission('banking.read')
  await requireFeatureEnabled(authz.user.orgId, 'banking')
  const t = await getTranslations('banking.payouts')
  const { money } = await getMoneyFormatter()
  const orgId = authz.user.orgId
  const subsidiaryFilter = authz.allowedSubsidiaryIds
    ? authz.allowedSubsidiaryIds.size > 0
      ? sql` and b.subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])`
      : sql` and false`
    : sql``

  // Unreconciled payouts: posted batches whose bank legs match no statement
  // line yet — the same derivation the drawer tie-out reads.
  const unreconciled = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from psp_settlement_batches b
     where b.org_id = ${orgId} and b.status = 'posted'${subsidiaryFilter}
       and not exists (
         select 1 from reconciliation_matches m
           join journal_lines jl on jl.org_id = m.org_id and jl.id = m.journal_line_id
          where m.org_id = b.org_id and jl.entry_id = b.journal_entry_id
            and jl.account_id = b.bank_account_id
       )
  `)).rows[0]
  const unmatched = (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from psp_settlement_lines l
      join psp_settlement_batches b on b.org_id = l.org_id and b.id = l.batch_id
     where l.org_id = ${orgId} and l.document_id is null
       and l.kind in ('charge', 'refund', 'dispute', 'dispute_reversal')${subsidiaryFilter}
  `)).rows[0]
  const inTransit = (await db.execute<{ count: string; total: string | null }>(sql`
    select count(*)::text as count, sum(a.amount)::text as total
      from psp_payout_accruals a
      join psp_settlement_batches b on b.org_id = a.org_id and b.id = a.batch_id
     where a.org_id = ${orgId} and a.status = 'accrued'${subsidiaryFilter}
  `)).rows[0]

  const queue = (await db.execute<PayoutQueueRow>(sql`
    select l.id as "lineId", l.batch_id as "batchId", b.provider,
           b.external_ref as "externalRef", b.settlement_date::text as "settlementDate",
           l.kind, l.amount::text as amount, l.currency
      from psp_settlement_lines l
      join psp_settlement_batches b on b.org_id = l.org_id and b.id = l.batch_id
     where l.org_id = ${orgId} and l.document_id is null
       and l.kind in ('charge', 'refund', 'dispute', 'dispute_reversal')${subsidiaryFilter}
     order by b.settlement_date desc, l.line_number
     limit 25
  `)).rows

  const batches = (await db.execute<{
    id: string
    provider: string
    externalRef: string
    settlementDate: string
    currency: string
    netAmount: string
    status: string
    unmatchedLines: number
  }>(sql`
    select b.id, b.provider, b.external_ref as "externalRef",
           b.settlement_date::text as "settlementDate", b.currency,
           b.net_amount::text as "netAmount", b.status,
           (select count(*)::int from psp_settlement_lines l
             where l.org_id = b.org_id and l.batch_id = b.id
               and l.document_id is null
               and l.kind in ('charge', 'refund', 'dispute', 'dispute_reversal')) as "unmatchedLines"
      from psp_settlement_batches b
     where b.org_id = ${orgId}${subsidiaryFilter}
     order by b.settlement_date desc, b.created_at desc
     limit 50
  `)).rows

  const batchIds = batches.map((row) => row.id)
  const tied = batchIds.length > 0
    ? new Set((await db.execute<{ id: string }>(sql`
        select distinct b.id from psp_settlement_batches b
          join journal_lines jl on jl.org_id = b.org_id and jl.entry_id = b.journal_entry_id
          join reconciliation_matches m on m.org_id = jl.org_id and m.journal_line_id = jl.id
         where b.org_id = ${orgId} and b.id = any(${`{${batchIds.join(',')}}`}::uuid[])
           and jl.account_id = b.bank_account_id
      `)).rows.map((row) => row.id))
    : new Set<string>()
  const accrued = batchIds.length > 0
    ? new Set((await db.execute<{ batch_id: string }>(sql`
        select distinct batch_id from psp_payout_accruals
         where org_id = ${orgId} and status = 'accrued'
           and batch_id = any(${`{${batchIds.join(',')}}`}::uuid[])
      `)).rows.map((row) => row.batch_id))
    : new Set<string>()

  const batchRows: PayoutBatchRow[] = batches.map((row) => ({
    id: row.id,
    provider: row.provider,
    externalRef: row.externalRef,
    settlementDate: row.settlementDate,
    currency: row.currency,
    netAmount: money(row.netAmount, { currency: row.currency }),
    status: row.status,
    statusLabel: t(`status.${row.status}`),
    unmatchedLines: row.unmatchedLines,
    tied: tied.has(row.id),
    accrued: accrued.has(row.id),
  }))

  return {
    title: t('title'),
    description: t('description'),
    emptyTitle: t('emptyTitle'),
    emptyDescription: t('emptyDescription'),
    canReconcile: can(authz, 'banking.reconcile'),
    tiles: [
      {
        label: t('unreconciledLabel'),
        value: unreconciled?.count ?? '0',
        sub: t('unreconciledSub'),
      },
      {
        label: t('unmatchedLabel'),
        value: unmatched?.count ?? '0',
        sub: t('unmatchedSub'),
      },
      {
        label: t('inTransitLabel'),
        value: inTransit?.count ?? '0',
        sub: t('inTransitSub'),
      },
    ],
    queue: queue.map((row) => ({
      ...row,
      amount: money(row.amount, { currency: row.currency }),
    })),
    batches: batchRows,
    reportHref: '/reports/payout-reconciliation',
    strings: {
      queueTitle: t('queueTitle'),
      queueEmpty: t('queueEmpty'),
      batchesTitle: t('batchesTitle'),
      batchesEmpty: t('batchesEmpty'),
      reportLinkLabel: t('reportLinkLabel'),
      matchLabel: t('matchLabel'),
      linkLabel: t('linkLabel'),
      unlinkLabel: t('unlinkLabel'),
      adjustLabel: t('adjustLabel'),
      accrueLabel: t('accrueLabel'),
      closeLabel: t('closeLabel'),
      retryLabel: t('retryLabel'),
      loadingLabel: t('loadingLabel'),
      loadFailedLabel: t('loadFailedLabel'),
      resolvePlaceholder: t('resolvePlaceholder'),
      matchedToast: t('matchedToast'),
      linkedToast: t('linkedToast'),
      unlinkedToast: t('unlinkedToast'),
      adjustedToast: t('adjustedToast'),
      accruedToast: t('accruedToast'),
      adjustConfirmTitle: t('adjustConfirmTitle'),
      adjustConfirmMessage: t('adjustConfirmMessage'),
      accrueConfirmMessage: t('accrueConfirmMessage'),
      accrueResultMessage: t('accrueResultMessage'),
      drawerTitle: t('drawerTitle'),
      tiedLabel: t('tiedLabel'),
      untiedLabel: t('untiedLabel'),
      untiedHint: t('untiedHint'),
      gapLabel: t('gapLabel'),
      accrualTitle: t('accrualTitle'),
      lineHead: t('lineHead'),
      kindHead: t('kindHead'),
      amountHead: t('amountHead'),
      documentHead: t('documentHead'),
      matchHead: t('matchHead'),
      actionHead: t('actionHead'),
      payoutHead: t('payoutHead'),
      dateHead: t('dateHead'),
      netHead: t('netHead'),
      statusHead: t('statusHead'),
      unmatchedHead: t('unmatchedHead'),
      depositHead: t('depositHead'),
      reviewLabel: t('reviewLabel'),
      openLabel: t('openLabel'),
      inTransitBadge: t('inTransitBadge'),
      accrueTitle: t('accrueTitle'),
      accrueSummary: t('accrueSummary'),
      accrualDateLabel: t('accrualDateLabel'),
      accrueHint: t('accrueHint'),
      workingLabel: t('workingLabel'),
      matchedLabel: t('matchedLabel'),
      unmatchedRowLabel: t('unmatchedRowLabel'),
      notApplicableLabel: t('notApplicableLabel'),
      kindLabels: {
        charge: t('kindLabels.charge'),
        refund: t('kindLabels.refund'),
        fee: t('kindLabels.fee'),
        dispute: t('kindLabels.dispute'),
        dispute_reversal: t('kindLabels.dispute_reversal'),
        adjustment: t('kindLabels.adjustment'),
        fx_adjustment: t('kindLabels.fx_adjustment'),
        transfer: t('kindLabels.transfer'),
        other: t('kindLabels.other'),
      },
      reasonLabels: {
        linked_missing: t('reasonLabels.linked_missing'),
        document_unposted: t('reasonLabels.document_unposted'),
        ambiguous_link: t('reasonLabels.ambiguous_link'),
        ambiguous_order: t('reasonLabels.ambiguous_order'),
        ambiguous_refund: t('reasonLabels.ambiguous_refund'),
        order_unknown: t('reasonLabels.order_unknown'),
        order_unposted: t('reasonLabels.order_unposted'),
        refund_unposted: t('reasonLabels.refund_unposted'),
        no_link: t('reasonLabels.no_link'),
        link_failed: t('reasonLabels.link_failed'),
      },
    },
  }
}

const f = ref<PayoutsData>()

export function payoutsSpec(): PageSpec {
  return page({
    route: '/banking/payouts',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3', [
        statTile({
          iconKey: 'landmark',
          accent: 'amber',
          label: f('tiles.0.label'),
          value: f('tiles.0.value'),
          sub: f('tiles.0.sub'),
        }),
        statTile({
          iconKey: 'list-checks',
          accent: 'amber',
          label: f('tiles.1.label'),
          value: f('tiles.1.value'),
          sub: f('tiles.1.sub'),
        }),
        statTile({
          iconKey: 'arrow-left-right',
          accent: 'teal',
          label: f('tiles.2.label'),
          value: f('tiles.2.value'),
          sub: f('tiles.2.sub'),
        }),
      ]),
      // One widget, not three: tiles, queue, batches and the payout drawer
      // share one state graph (the drawer refreshes the queue after every
      // match), so the spec places the console whole.
      widgetBlock('payouts-console', {
        canReconcile: f('canReconcile'),
        tiles: f('tiles'),
        queue: f('queue'),
        batches: f('batches'),
        reportHref: f('reportHref'),
        strings: f('strings'),
        emptyTitle: f('emptyTitle'),
        emptyDescription: f('emptyDescription'),
      }),
    ],
  })
}
