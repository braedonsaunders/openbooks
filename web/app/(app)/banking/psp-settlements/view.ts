import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, frame, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { subsidiaryUiOptions } from '../../../../lib/subsidiaries'
import { getMoneyFormatter } from '@/lib/money-server'
import type { PspAccountOption, PspSettlementRow, PspSubsidiaryOption } from './sections'

/**
 * PSP settlement import + batches, split into a loader and a spec.
 *
 * This page is the first fully client-driven surface conversion: the native
 * page is a `"use client"` component whose batch list arrives via
 * `fetch('/api/psp/settlements')` and whose import/post/reverse mutations
 * all run browser-side. The spec path cannot fetch (specs bind
 * loader-resolved data), so the loader performs the GET contract itself —
 * same permission gate (`banking.read`), same feature flag (`banking`),
 * same subsidiary scoping, same `order by settlement_date desc` + limit 50
 * — and hands the rows to the shared `PspSettlementsWorkspace`, which owns
 * every interactive branch the native page owns (import form, reversal
 * form, per-row Post/Reverse with the reason-length rule).
 *
 * What the loader does NOT reproduce is the mutation path: import/post/
 * reverse stay inside the workspace component (API calls + toasts), exactly
 * where they live natively. The loader resolves the read model only.
 */

type SettlementStatus = 'draft' | 'posted' | 'void'

const STATUS_MESSAGE: Record<SettlementStatus, 'draft' | 'posted' | 'voided'> = {
  draft: 'draft',
  posted: 'posted',
  void: 'voided',
}

export interface PspSettlementsStrings {
  acceptanceNote: string
  acceptanceLink: string
  importTitle: string
  providerLabel: string
  externalRef: string
  settlementDate: string
  bankAccountId: string
  bankAccountHint: string
  feeAccountId: string
  feeAccountHint: string
  clearingAccountId: string
  clearingAccountHint: string
  subsidiaryLabel: string
  noneLabel: string
  payloadShapeHint: string
  genericPayloadHint: string
  accountPlaceholder: string
  uploadPayload: string
  invalidStripePayload: string
  invalidGenericPayload: string
  importDraft: string
  recentBatches: string
  reversalDate: string
  reversalReason: string
  reversalPlaceholder: string
  colProvider: string
  colNet: string
  reverse: string
  empty: string
  referenceLabel: string
  dateLabel: string
  statusLabel: string
  postLabel: string
  loadingLabel: string
  loadFailedLabel: string
  retryLabel: string
}

export interface PspSettlementsData {
  title: string
  description: string
  /** Loader-resolved banking.reconcile grant, never an Authz: the import
   *  form and the post/reverse buttons POST with banking.reconcile, so a
   *  read-only operator must not see them (F1T-9). */
  canReconcile: boolean
  strings: PspSettlementsStrings
  rows: PspSettlementRow[]
  subsidiaries: PspSubsidiaryOption[]
  /** Postable chart accounts for the import form's house pickers — the same
   *  active/non-summary population the import validates against, so a picked
   *  account cannot strand the draft at posting. */
  accounts: PspAccountOption[]
}

interface BatchRow extends Record<string, unknown> {
  id: string
  provider: string
  externalRef: string
  settlementDate: string
  currency: string
  netAmount: string
  status: string
}

export async function loadPspSettlements(): Promise<PspSettlementsData> {
  // The house refusal names banking.read (F1T-10): a reader without it sees
  // /access-denied, never a silent bounce home.
  const authz = await requirePermission('banking.read')
  // Same gate as GET /api/psp/settlements: a disabled banking feature 404s
  // the surface, and banking.read guards the read model.
  await requireFeatureEnabled(authz.user.orgId, 'banking')
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('banking.pspSettlements')
  const common = await getTranslations('common')

  const subsidiaryFilter = authz.allowedSubsidiaryIds
    ? authz.allowedSubsidiaryIds.size > 0
      ? sql` and subsidiary_id = any(${`{${[...authz.allowedSubsidiaryIds].join(',')}}`}::uuid[])`
      : sql` and false`
    : sql``
  const batches = await db.execute<BatchRow>(sql`
    select id, provider, external_ref as "externalRef", status, currency, net_amount as "netAmount",
           settlement_date as "settlementDate"
      from psp_settlement_batches
     where org_id = ${authz.user.orgId}${subsidiaryFilter}
     order by settlement_date desc, created_at desc limit 50
  `)
  // The import form's subsidiary picker: same flag gate and caller scope as
  // the document drawers (F-t06-004). Empty keeps all subsidiary UI hidden
  // and the batch posts to the root like every other document.
  const subsidiaryScope = await subsidiaryUiOptions(authz.user.orgId)
  const subsidiaries = subsidiaryScope
    .filter((option) => !authz.allowedSubsidiaryIds || authz.allowedSubsidiaryIds.has(option.id))
    .map((option) => ({ id: option.id, name: option.name, baseCurrency: option.baseCurrency }))
  // The import form's house account pickers: exactly the population the
  // import validates (active, non-summary accounts of this org), labelled
  // `number · name` like every other account picker. The stored value stays
  // the UUID — only the affordance changes.
  const accountRows = await db.execute<{ id: string; number: string | null; name: string }>(sql`
    select id, number, name from accounts
     where org_id = ${authz.user.orgId} and is_active and not is_summary
     order by number nulls last, name limit 2000
  `)
  const accounts = accountRows.rows.map((a) => ({
    id: String(a.id),
    label: `${a.number ? `${a.number} · ` : ''}${a.name}`,
  }))

  const dateLabel = (value: string) =>
    new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })

  return {
    title: t('title'),
    description: t('description'),
    canReconcile: can(authz, 'banking.reconcile'),
    strings: {
      acceptanceNote: t('acceptanceNote'),
      acceptanceLink: t('acceptanceLink'),
      importTitle: t('importTitle'),
      providerLabel: t('providerLabel'),
      externalRef: t('externalRef'),
      settlementDate: t('settlementDate'),
      bankAccountId: t('bankAccountId'),
      bankAccountHint: t('bankAccountHint'),
      feeAccountId: t('feeAccountId'),
      feeAccountHint: t('feeAccountHint'),
      clearingAccountId: t('clearingAccountId'),
      clearingAccountHint: t('clearingAccountHint'),
      subsidiaryLabel: common('labels.subsidiary'),
      noneLabel: common('labels.none'),
      payloadShapeHint: t('payloadShapeHint'),
      genericPayloadHint: t('genericPayloadHint'),
      accountPlaceholder: t('accountPlaceholder'),
      uploadPayload: t('uploadPayload'),
      invalidStripePayload: t('invalidStripePayload'),
      invalidGenericPayload: t('invalidGenericPayload'),
      importDraft: t('importDraft'),
      recentBatches: t('recentBatches'),
      reversalDate: t('reversalDate'),
      reversalReason: t('reversalReason'),
      reversalPlaceholder: t('reversalPlaceholder'),
      colProvider: t('colProvider'),
      colNet: t('colNet'),
      reverse: t('reverse'),
      empty: t('empty'),
      referenceLabel: common('labels.reference'),
      dateLabel: common('labels.date'),
      statusLabel: common('labels.status'),
      postLabel: common('actions.post'),
      loadingLabel: common('feedback.loading'),
      loadFailedLabel: common('feedback.loadFailed'),
      retryLabel: common('actions.retry'),
    },
    subsidiaries,
    accounts,
    rows: batches.rows.map((b) => ({
      id: String(b.id),
      providerLabel: t(`providers.${b.provider}`),
      externalRef: String(b.externalRef),
      settlementDate: dateLabel(String(b.settlementDate).slice(0, 10)),
      netAmount: money(String(b.netAmount), { currency: String(b.currency) }),
      // `common`, not the page namespace: the client component resolves this
      // label from common.status.*, and the page namespace has no status keys
      // at all — so the page namespace renders the raw key path.
      statusLabel: common(`status.${STATUS_MESSAGE[b.status as SettlementStatus]}`),
      status: b.status as SettlementStatus,
    })),
  }
}

const f = ref<PspSettlementsData>()

export function pspSettlementsSpec(data: PspSettlementsData): PageSpec {
  return page({
    route: '/banking/psp-settlements',
    // List chrome outside (sticky PageHeader), PageContainer scroll shell
    // inside — the native page nests exactly this pair.
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      frame(
        'page-container',
        [
          // No wrapper: the frame already carries `space-y-6`, and a second
          // div here is markup the native page does not have.
          widgetBlock('psp-settlements', {
            // No `acceptanceHref`: the workspace hardcodes that route itself,
            // so passing it here reached nothing. Wiring the route through
            // properly is a separate cleanup — this only stops pretending it
            // is already wired.
            canReconcile: data.canReconcile,
            strings: data.strings,
            initialRows: data.rows,
            initialSubsidiaries: data.subsidiaries,
            initialAccounts: data.accounts,
          }),
        ],
        { className: 'space-y-6' },
      ),
    ],
  })
}
