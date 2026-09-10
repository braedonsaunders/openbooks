import { getTranslations } from 'next-intl/server'
import { EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomePanel, HomeStatTile } from '../../../components/module-home/client'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadComplianceOverview, requireComplianceFeature, stateTone } from '../../../lib/compliance'
import { getMoneyFormatter } from '@/lib/money-server'
import { decimalCmp } from '../../../lib/statement-format'
import { complianceTabs } from './tabs'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadCompliance, complianceSpec } from './view'
import {
  BlockedBillsSection,
  ComplianceSetupBanner,
  ExpiringVendorsSection,
  ReadinessPanel,
  WaiversPanel,
} from './sections'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('title') }
}

/**
 * Subcontractor compliance cockpit — the four questions a general contractor's
 * office asks every morning, in the order money is at risk:
 *
 *   1. Whose money is blocked right now, and how much of it?
 *   2. What lapses this month?
 *   3. Which lien waivers are still outstanding?
 *   4. Are we ready to file 1099s?
 *
 * Read-only by design: every action lives on the record it belongs to, so there
 * is one editable home per fact.
 */
export default async function ComplianceHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadCompliance(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={complianceSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const t = await getTranslations('compliance')
  const { money, moneyCompact } = await getMoneyFormatter()
  const sp = await searchParams
  const yearParam = Number(Array.isArray(sp.year) ? sp.year[0] : sp.year)
  // 1099s are prepared for the year that just ended, so that is the default.
  const taxYear = Number.isInteger(yearParam) ? yearParam : Number((await businessToday(orgId)).slice(0, 4)) - 1

  const [overview, projectsEnabled] = await Promise.all([
    loadComplianceOverview(orgId, taxYear, authz.allowedSubsidiaryIds),
    isFeatureEnabled(orgId, 'projects'),
  ])
  const tabs = await complianceTabs('/compliance', { projectsEnabled })

  const blockedCount = overview.blockedBills.filter((b) => b.decision === 'blocked').length

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader title={t('title')} description={t('description')} />
          <ModuleHomeTabs tabs={tabs} />
        </>
      }
    >
      {!overview.configured ? (
        <ComplianceSetupBanner
          prompt={t('setup.prompt')}
          actionHref="/admin/setup/compliance-classes"
          actionLabel={t('setup.action')}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HomeStatTile
          icon="users"
          label={t('stats.tracked')}
          value={String(overview.trackedVendors)}
          sub={t('stats.trackedHint', { count: overview.policyCount })}
          accent="slate"
        />
        <HomeStatTile
          icon="check"
          label={t('stats.compliant')}
          value={String(overview.byState.compliant + overview.byState.waived)}
          sub={t('stats.compliantHint', { expiring: overview.byState.expiring })}
          accent="emerald"
          tone={overview.byState.expiring > 0 ? 'warning' : 'positive'}
        />
        <HomeStatTile
          icon="triangle-alert"
          label={t('stats.blocked')}
          value={String(overview.blockedVendors)}
          sub={t('stats.blockedHint', { bills: blockedCount })}
          accent={overview.blockedVendors > 0 ? 'red' : 'slate'}
          tone={overview.blockedVendors > 0 ? 'negative' : 'neutral'}
        />
        <HomeStatTile
          icon="wallet"
          label={t('stats.exposure')}
          value={moneyCompact(overview.blockedExposure)}
          sub={t('stats.exposureHint')}
          accent={decimalCmp(overview.blockedExposure, '0') > 0 ? 'amber' : 'slate'}
          tone={decimalCmp(overview.blockedExposure, '0') > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <HomePanel
          icon="triangle-alert"
          title={t('panels.blocked')}
          hint={t('panels.blockedHint')}
          bodyClassName="p-0"
        >
          <BlockedBillsSection
            rows={overview.blockedBills.map((bill) => ({
              documentId: bill.documentId,
              documentNumber: bill.documentNumber,
              billHref: `/ap/bills?doc=${bill.documentId}`,
              vendorName: bill.vendorName,
              decisionLabel: t(`decision.${bill.decision}`),
              decisionVariant: bill.decision === 'blocked' ? 'destructive' : 'warning',
              reasons: bill.reasons.join(' · '),
              openBalance: money(bill.openBalance),
            }))}
            empty={t('panels.blockedEmpty')}
          />
        </HomePanel>

        <HomePanel
          icon="calendar-clock"
          title={t('panels.expiring')}
          hint={t('panels.expiringHint')}
          bodyClassName="p-0"
        >
          <ExpiringVendorsSection
            rows={overview.expiringSoon.map((row) => ({
              partyId: row.partyId,
              vendorHref: `/compliance/vendors?vendor=${row.partyId}`,
              vendorName: row.vendorName,
              stateLabel: t(`states.${row.overall}`),
              stateVariant: stateTone(row.overall),
              nextExpiry: row.nextExpiry,
            }))}
            empty={t('panels.expiringEmpty')}
          />
        </HomePanel>

        {projectsEnabled ? (
          <WaiversPanel
            title={t('panels.waivers')}
            hint={t('panels.waiversHint')}
            actionHref="/compliance/lien-waivers"
            actionLabel={t('panels.waiversAction')}
            rows={overview.outstandingWaivers.map((waiver) => ({
              id: waiver.id,
              waiverHref: `/compliance/lien-waivers?waiver=${waiver.id}`,
              waiverNumber: waiver.waiverNumber,
              context: `${waiver.partyName} · ${waiver.projectName}`,
              statusLabel: t(`waiverStatus.${waiver.status}`),
              throughDate: waiver.throughDate,
            }))}
            empty={t('panels.waiversEmpty')}
          />
        ) : null}

        <ReadinessPanel
          title={t('panels.readiness', { year: taxYear })}
          hint={t('panels.readinessHint')}
          actionHref="/compliance/information-returns"
          actionLabel={t('panels.readinessAction')}
          rows={overview.readiness.map((row) => ({
            partyId: row.partyId,
            vendorHref: `/compliance/vendors?vendor=${row.partyId}`,
            vendorName: row.vendorName,
            issue: !row.reportable
              ? t('readiness.unflagged')
              : !row.hasTin
                ? t('readiness.missingTin')
                : t('readiness.noForm'),
            paidThisYear: money(row.paidThisYear),
          }))}
          empty={t('panels.readinessEmpty')}
        />
      </div>

      {overview.filings.length === 0 && overview.trackedVendors === 0 && overview.configured ? (
        <div className="mt-4">
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        </div>
      ) : null}
    </ListPageLayout>
  )
}
