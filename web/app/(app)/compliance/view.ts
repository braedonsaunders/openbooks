import 'server-only'

import { getTranslations } from 'next-intl/server'
import { grid, page, pageHeader, panel, ref, statTile, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadComplianceOverview, requireComplianceFeature, stateTone } from '../../../lib/compliance'
import { getMoneyFormatter } from '@/lib/money-server'
import { decimalCmp } from '../../../lib/statement-format'
import { complianceTabs } from './tabs'
import type {
  BlockedBillItem,
  ExpiringVendorItem,
  OutstandingWaiverItem,
  ReadinessQueueItem,
} from './sections'

/**
 * The subcontractor compliance cockpit, split into a loader and a spec.
 *
 * This is a cockpit, not a list: the purchasing page set the precedent, and
 * this page follows it. ViewSpec composes the grid and the panels; the panel
 * BODIES stay components in ./sections, shared by the page and the widget registry so they
 * cannot drift. The rows those components take are presentation-ready data —
 * labels resolved, hrefs built, money formatted — computed in the loader from
 * the native page's logic verbatim.
 *
 * Four loader-resolved flags choose the page's independent regions: the setup
 * banner (unconfigured), the waivers panel (projects gate), and the bottom
 * empty state (configured but nothing filed and nobody tracked). The spec
 * never branches; each region is present or omitted on its own flag.
 */

export interface ComplianceData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof complianceTabs>>
  showSetupBanner: boolean
  setupPrompt: string
  setupAction: { href: string; label: string }
  trackedLabel: string
  trackedValue: string
  trackedSub: string
  compliantLabel: string
  compliantValue: string
  compliantSub: string
  compliantTone: 'positive' | 'warning'
  blockedLabel: string
  blockedValue: string
  blockedSub: string
  blockedAccent: 'red' | 'slate'
  blockedTone: 'negative' | 'neutral'
  exposureLabel: string
  exposureValue: string
  exposureSub: string
  exposureAccent: 'amber' | 'slate'
  exposureTone: 'warning' | 'neutral'
  blockedTitle: string
  blockedHint: string
  blockedBills: BlockedBillItem[]
  blockedEmpty: string
  expiringTitle: string
  expiringHint: string
  expiringSoon: ExpiringVendorItem[]
  expiringEmpty: string
  showWaivers: boolean
  waiversTitle: string
  waiversHint: string
  waiversAction: { href: string; label: string }
  outstandingWaivers: OutstandingWaiverItem[]
  waiversEmpty: string
  readinessTitle: string
  readinessHint: string
  readinessAction: { href: string; label: string }
  readiness: ReadinessQueueItem[]
  readinessEmpty: string
  showEmpty: boolean
  emptyTitle: string
  emptyDescription: string
}

export async function loadCompliance(
  sp: Record<string, string | string[] | undefined>,
): Promise<ComplianceData> {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const t = await getTranslations('compliance')
  const { money, moneyCompact } = await getMoneyFormatter()
  const yearParam = Number(Array.isArray(sp.year) ? sp.year[0] : sp.year)
  // 1099s are prepared for the year that just ended, so that is the default.
  const taxYear = Number.isInteger(yearParam) ? yearParam : Number((await businessToday(orgId)).slice(0, 4)) - 1

  const [overview, projectsEnabled] = await Promise.all([
    loadComplianceOverview(orgId, taxYear, authz.allowedSubsidiaryIds),
    isFeatureEnabled(orgId, 'projects'),
  ])
  const tabs = await complianceTabs('/compliance', { projectsEnabled })

  const blockedCount = overview.blockedBills.filter((b) => b.decision === 'blocked').length

  return {
    title: t('title'),
    description: t('description'),
    tabs,
    showSetupBanner: !overview.configured,
    setupPrompt: t('setup.prompt'),
    setupAction: { href: '/admin/setup/compliance-classes', label: t('setup.action') },
    trackedLabel: t('stats.tracked'),
    trackedValue: String(overview.trackedVendors),
    trackedSub: t('stats.trackedHint', { count: overview.policyCount }),
    compliantLabel: t('stats.compliant'),
    compliantValue: String(overview.byState.compliant + overview.byState.waived),
    compliantSub: t('stats.compliantHint', { expiring: overview.byState.expiring }),
    compliantTone: overview.byState.expiring > 0 ? 'warning' : 'positive',
    blockedLabel: t('stats.blocked'),
    blockedValue: String(overview.blockedVendors),
    blockedSub: t('stats.blockedHint', { bills: blockedCount }),
    blockedAccent: overview.blockedVendors > 0 ? 'red' : 'slate',
    blockedTone: overview.blockedVendors > 0 ? 'negative' : 'neutral',
    exposureLabel: t('stats.exposure'),
    exposureValue: moneyCompact(overview.blockedExposure),
    exposureSub: t('stats.exposureHint'),
    exposureAccent: decimalCmp(overview.blockedExposure, '0') > 0 ? 'amber' : 'slate',
    exposureTone: decimalCmp(overview.blockedExposure, '0') > 0 ? 'warning' : 'neutral',
    blockedTitle: t('panels.blocked'),
    blockedHint: t('panels.blockedHint'),
    blockedBills: overview.blockedBills.map((bill) => ({
      documentId: bill.documentId,
      documentNumber: bill.documentNumber,
      billHref: `/ap/bills?doc=${bill.documentId}`,
      vendorName: bill.vendorName,
      decisionLabel: t(`decision.${bill.decision}`),
      decisionVariant: bill.decision === 'blocked' ? ('destructive' as const) : ('warning' as const),
      reasons: bill.reasons.join(' · '),
      openBalance: money(bill.openBalance),
    })),
    blockedEmpty: t('panels.blockedEmpty'),
    expiringTitle: t('panels.expiring'),
    expiringHint: t('panels.expiringHint'),
    expiringSoon: overview.expiringSoon.map((row) => ({
      partyId: row.partyId,
      vendorHref: `/compliance/vendors?vendor=${row.partyId}`,
      vendorName: row.vendorName,
      stateLabel: t(`states.${row.overall}`),
      stateVariant: stateTone(row.overall),
      nextExpiry: row.nextExpiry,
    })),
    expiringEmpty: t('panels.expiringEmpty'),
    showWaivers: projectsEnabled,
    waiversTitle: t('panels.waivers'),
    waiversHint: t('panels.waiversHint'),
    waiversAction: { href: '/compliance/lien-waivers', label: t('panels.waiversAction') },
    outstandingWaivers: overview.outstandingWaivers.map((waiver) => ({
      id: waiver.id,
      waiverHref: `/compliance/lien-waivers?waiver=${waiver.id}`,
      waiverNumber: waiver.waiverNumber,
      context: `${waiver.partyName} · ${waiver.projectName}`,
      statusLabel: t(`waiverStatus.${waiver.status}`),
      throughDate: waiver.throughDate,
    })),
    waiversEmpty: t('panels.waiversEmpty'),
    readinessTitle: t('panels.readiness', { year: taxYear }),
    readinessHint: t('panels.readinessHint'),
    readinessAction: { href: '/compliance/information-returns', label: t('panels.readinessAction') },
    readiness: overview.readiness.map((row) => ({
      partyId: row.partyId,
      vendorHref: `/compliance/vendors?vendor=${row.partyId}`,
      vendorName: row.vendorName,
      issue: !row.reportable
        ? t('readiness.unflagged')
        : !row.hasTin
          ? t('readiness.missingTin')
          : t('readiness.noForm'),
      paidThisYear: money(row.paidThisYear),
    })),
    readinessEmpty: t('panels.readinessEmpty'),
    showEmpty: overview.filings.length === 0 && overview.trackedVendors === 0 && overview.configured,
    emptyTitle: t('empty.title'),
    emptyDescription: t('empty.description'),
  }
}

const f = ref<ComplianceData>()

export function complianceSpec(data: ComplianceData): PageSpec {
  return page({
    route: '/compliance',
    layout: 'list',
    header: [
      pageHeader({ title: f('title'), description: f('description') }),
      widgetBlock('module-home-tabs', { tabs: data.tabs }),
    ],
    body: [
      {
        ...widgetBlock('compliance-setup-banner', {
          prompt: data.setupPrompt,
          actionHref: data.setupAction.href,
          actionLabel: data.setupAction.label,
        }),
        when: f('showSetupBanner'),
      },
      grid('grid gap-3 sm:grid-cols-2 xl:grid-cols-4', [
        statTile({ iconKey: 'users', accent: 'slate', label: f('trackedLabel'), value: f('trackedValue'), sub: f('trackedSub') }),
        statTile({
          iconKey: 'check',
          accent: 'emerald',
          label: f('compliantLabel'),
          value: f('compliantValue'),
          sub: f('compliantSub'),
          tone: f('compliantTone'),
        }),
        statTile({
          iconKey: 'triangle-alert',
          accent: f('blockedAccent'),
          label: f('blockedLabel'),
          value: f('blockedValue'),
          sub: f('blockedSub'),
          tone: f('blockedTone'),
        }),
        statTile({
          iconKey: 'wallet',
          accent: f('exposureAccent'),
          label: f('exposureLabel'),
          value: f('exposureValue'),
          sub: f('exposureSub'),
          tone: f('exposureTone'),
        }),
      ]),
      grid('mt-4 grid gap-4 xl:grid-cols-2', [
        panel({
          title: f('blockedTitle'),
          iconKey: 'triangle-alert',
          hint: f('blockedHint'),
          bodyClassName: 'p-0',
          blocks: [widgetBlock('blocked-bills', { rows: data.blockedBills, empty: data.blockedEmpty })],
        }),
        panel({
          title: f('expiringTitle'),
          iconKey: 'calendar-clock',
          hint: f('expiringHint'),
          bodyClassName: 'p-0',
          blocks: [widgetBlock('expiring-vendors', { rows: data.expiringSoon, empty: data.expiringEmpty })],
        }),
        {
          ...widgetBlock('waivers-panel', {
            title: data.waiversTitle,
            hint: data.waiversHint,
            actionHref: data.waiversAction.href,
            actionLabel: data.waiversAction.label,
            rows: data.outstandingWaivers,
            empty: data.waiversEmpty,
          }),
          when: f('showWaivers'),
        },
        widgetBlock('readiness-panel', {
          title: data.readinessTitle,
          hint: data.readinessHint,
          actionHref: data.readinessAction.href,
          actionLabel: data.readinessAction.label,
          rows: data.readiness,
          empty: data.readinessEmpty,
        }),
      ]),
      {
        ...grid('mt-4', [
          widgetBlock('empty-state', { title: data.emptyTitle, description: data.emptyDescription }),
        ]),
        when: f('showEmpty'),
      },
    ],
  })
}
