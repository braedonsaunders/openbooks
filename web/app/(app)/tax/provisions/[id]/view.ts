import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  grid,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@openbooks/viewspec'
import { requirePermission, can } from '../../../../../lib/authz'
import { getMoneyFormatter } from '@/lib/money-server'
import { orgInfo } from '../../../../../lib/data'
import { getProvisionRun } from '@openbooks/engine/src/income-tax-provision.ts'
import type { ProvisionDifference, ProvisionSummary, ReconStep } from './sections'

/**
 * One income-tax provision run, split into a loader and a spec.
 *
 * The loader copies the native query, permission and formatting logic
 * verbatim: the `reports.read` gate, the entity-projected `getProvisionRun`
 * read (a run with no visible entity is indistinguishable from a missing
 * one, so restricted callers 404 here exactly as on the native path), the
 * money formatting, and the `gl.post` + unrestricted + draft posting rule.
 *
 * Both sections stay widgets, not `table` blocks — the same call the
 * admin-users conversion made. The native page hand-rolls two plain
 * `<table>`s with their own header, divider and hover classes; the spec's
 * table block offers only the two real table variants the app has.
 * The conditional pairs (post button, IAS 12 vs ASC 740 copy, empty
 * differences note) resolve to loader flags and shared components.
 */

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'outline'> = {
  draft: 'secondary',
  posted: 'success',
  superseded: 'outline',
}

export interface ProvisionDetailData {
  headerTitle: string
  backHref: string
  backLabel: string
  frameworkLabel: string
  statusLabel: string
  statusVariant: 'success' | 'secondary' | 'outline'
  canPost: boolean
  runId: string
  reconTitle: string
  pretaxLabel: string
  pretaxAmount: string
  enactedRateText: string
  amountLabel: string
  percentLabel: string
  steps: ReconStep[]
  summaries: ProvisionSummary[]
  diffTitle: string
  diffEmptyNote: string
  diffColumns: {
    item: string
    bookBasis: string
    taxBasis: string
    difference: string
    effect: string
  }
  differences: ProvisionDifference[]
}

export async function loadProvisionDetail(
  _sp: Record<string, string | string[] | undefined>,
  id: string,
): Promise<ProvisionDetailData> {
  const authz = await requirePermission('reports.read')
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('tax.provisions')
  const org = await orgInfo()
  // Same entity projection as the REST twin: a run with no visible entity is
  // indistinguishable from a missing one.
  const run = await getProvisionRun(authz.user.orgId, id, authz.allowedSubsidiaryIds)
  if (!run) notFound()
  const m = (v: string) => money(v, { currency: org?.base_currency })
  const payload = run.payload as {
    framework?: 'asc740' | 'ias12'
    pretaxBookIncome: string
    enactedRatePercent: string
    taxableIncome: string
    currentTax: string
    deferredExpense: string
    totalExpense: string
    balances: { dtaGross: string; dtlGross: string; valuationAllowance: string }
    rateReconciliation: { key: string; label: string; amount: string; percent: string | null }[]
  }
  const framework = payload.framework ?? 'asc740'
  const recon = payload.rateReconciliation ?? []
  // Posting is the gl.post route's authority, and it refuses restricted callers
  // (a provision posts the whole entity set); the button mirrors both.
  const canPost = can(authz, 'gl.post') && authz.allowedSubsidiaryIds === null && run.status === 'draft'

  return {
    headerTitle: t('detail.title', { year: run.fiscalYear, version: run.version }),
    backHref: '/tax/provisions',
    backLabel: t('title'),
    frameworkLabel: framework === 'ias12' ? 'IAS 12' : 'ASC 740',
    statusLabel: t(`status.${run.status}`),
    statusVariant: STATUS_VARIANT[run.status] ?? 'secondary',
    canPost,
    runId: run.id,
    reconTitle: t('detail.reconciliation'),
    pretaxLabel: t('detail.pretax'),
    pretaxAmount: m(payload.pretaxBookIncome),
    enactedRateText: `${payload.enactedRatePercent}%`,
    amountLabel: t('detail.amount'),
    percentLabel: t('detail.percent'),
    steps: recon.map((step) => ({
      key: step.key,
      // The total step renders translated copy, not the engine label.
      label: step.label,
      amount: m(step.amount),
      percent: step.percent,
      isTotal: step.key === 'total',
      totalLabel: t('detail.total'),
    })),
    summaries: [
      { label: t('detail.taxableIncome'), value: m(payload.taxableIncome) },
      { label: t('detail.currentTax'), value: m(payload.currentTax) },
      { label: t('detail.deferredExpense'), value: m(payload.deferredExpense) },
      { label: t('detail.balances.dta'), value: m(payload.balances.dtaGross) },
      { label: t('detail.balances.dtl'), value: m(payload.balances.dtlGross) },
      {
        label: framework === 'ias12' ? t('detail.balances.vaIas12') : t('detail.balances.va'),
        value: m(payload.balances.valuationAllowance),
      },
    ],
    diffTitle: t('detail.differences'),
    diffEmptyNote: t('detail.noDifferences'),
    diffColumns: {
      item: t('detail.columns.item'),
      bookBasis: t('detail.columns.bookBasis'),
      taxBasis: t('detail.columns.taxBasis'),
      difference: t('detail.columns.difference'),
      effect: t('detail.columns.effect'),
    },
    differences: run.differences.map((d) => ({
      id: d.id,
      description: d.description,
      categorySourceLabel: `${t(`categories.${d.category}`)} · ${d.source === 'auto' ? t('detail.auto') : t('detail.manual')}`,
      bookBasis: m(d.bookBasis),
      taxBasis: m(d.taxBasis),
      difference: m(d.difference),
      taxEffect: m(d.taxEffect),
    })),
  }
}

const f = ref<ProvisionDetailData>()

export function provisionDetailSpec(data: ProvisionDetailData): PageSpec {
  return page({
    route: '/tax/provisions/[id]',
    layout: 'list',
    header: [
      pageHeader({
        title: f('headerTitle'),
        back: { href: f('backHref'), label: f('backLabel') },
        actionsClassName: 'flex items-center gap-2',
        actions: [
          widget('provision-framework-badge', { label: data.frameworkLabel }),
          widget('provision-status-badge', {
            label: data.statusLabel,
            variant: data.statusVariant,
          }),
          widget('provision-post-button', { runId: data.runId }, f('canPost')),
        ],
      }),
    ],
    body: [
      grid('grid gap-6 lg:grid-cols-2', [
        widgetBlock('provision-recon-section', {
          title: data.reconTitle,
          pretaxLabel: data.pretaxLabel,
          pretaxAmount: data.pretaxAmount,
          enactedRateText: data.enactedRateText,
          amountLabel: data.amountLabel,
          percentLabel: data.percentLabel,
          steps: data.steps,
          summaries: data.summaries,
        }),
        widgetBlock('provision-differences-section', {
          title: data.diffTitle,
          emptyNote: data.diffEmptyNote,
          columns: data.diffColumns,
          differences: data.differences,
        }),
      ]),
    ],
  })
}
