import 'server-only'

import { redirect, notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { grid, page, pageHeader, frame, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, getAuthz } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { getMoneyFormatter } from '@/lib/money-server'
import type { PspSettlementRow } from './sections'

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
  feeAccountId: string
  clearingAccountId: string
  uuidPlaceholder: string
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
  acceptanceHref: string
  strings: PspSettlementsStrings
  rows: PspSettlementRow[]
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
  const authz = await getAuthz()
  if (!authz) redirect('/login')
  // Same gate as GET /api/psp/settlements: a disabled banking feature 404s
  // the surface, and banking.read guards the read model.
  if (!(await isFeatureEnabled(authz.user.orgId, 'banking'))) notFound()
  if (!can(authz, 'banking.read')) redirect('/')
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
    acceptanceHref: '/admin/setup/payment-providers',
    strings: {
      acceptanceNote: t('acceptanceNote'),
      acceptanceLink: t('acceptanceLink'),
      importTitle: t('importTitle'),
      providerLabel: t('providerLabel'),
      externalRef: t('externalRef'),
      settlementDate: t('settlementDate'),
      bankAccountId: t('bankAccountId'),
      feeAccountId: t('feeAccountId'),
      clearingAccountId: t('clearingAccountId'),
      uuidPlaceholder: t('uuidPlaceholder'),
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
            acceptanceHref: data.acceptanceHref,
            strings: data.strings,
            initialRows: data.rows,
          }),
        ],
        { className: 'space-y-6' },
      ),
    ],
  })
}
