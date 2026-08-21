import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Alert, AlertDescription, Badge, Button, EmptyState, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { HomePanel, HomeStatTile } from '../../../components/module-home/client'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadComplianceOverview, requireComplianceFeature, stateTone } from '../../../lib/compliance'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from './tabs'

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
    loadComplianceOverview(orgId, taxYear),
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
        <Alert className="mb-4">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('setup.prompt')}</span>
            <Button asChild size="sm">
              <Link href="/admin/setup/compliance-classes">{t('setup.action')}</Link>
            </Button>
          </AlertDescription>
        </Alert>
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
          value={moneyCompact(Number(overview.blockedExposure))}
          sub={t('stats.exposureHint')}
          accent={Number(overview.blockedExposure) > 0 ? 'amber' : 'slate'}
          tone={Number(overview.blockedExposure) > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <HomePanel
          icon="triangle-alert"
          title={t('panels.blocked')}
          hint={t('panels.blockedHint')}
          bodyClassName="p-0"
        >
          {overview.blockedBills.length === 0 ? (
            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('panels.blockedEmpty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {overview.blockedBills.map((bill) => (
                <li key={bill.documentId} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={bill.decision === 'blocked' ? 'destructive' : 'warning'}>
                        {t(`decision.${bill.decision}`)}
                      </Badge>
                      <Link
                        href={`/ap/bills?doc=${bill.documentId}`}
                        className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
                      >
                        {bill.documentNumber}
                      </Link>
                      <span className="truncate text-sm text-slate-500 dark:text-slate-400">{bill.vendorName}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                      {bill.reasons.join(' · ')}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                    {money(Number(bill.openBalance))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </HomePanel>

        <HomePanel
          icon="calendar-clock"
          title={t('panels.expiring')}
          hint={t('panels.expiringHint')}
          bodyClassName="p-0"
        >
          {overview.expiringSoon.length === 0 ? (
            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('panels.expiringEmpty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {overview.expiringSoon.map((row) => (
                <li key={row.partyId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link
                    href={`/compliance/vendors?vendor=${row.partyId}`}
                    className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
                  >
                    {row.vendorName}
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant={stateTone(row.overall)}>{t(`states.${row.overall}`)}</Badge>
                    <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">{row.nextExpiry}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </HomePanel>

        {projectsEnabled ? (
          <HomePanel
            icon="clipboard"
            title={t('panels.waivers')}
            hint={t('panels.waiversHint')}
            bodyClassName="p-0"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/compliance/lien-waivers">{t('panels.waiversAction')}</Link>
              </Button>
            }
          >
            {overview.outstandingWaivers.length === 0 ? (
              <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('panels.waiversEmpty')}</p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {overview.outstandingWaivers.map((waiver) => (
                  <li key={waiver.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <Link
                        href={`/compliance/lien-waivers?waiver=${waiver.id}`}
                        className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
                      >
                        {waiver.waiverNumber}
                      </Link>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {waiver.partyName} · {waiver.projectName}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="warning">{t(`waiverStatus.${waiver.status}`)}</Badge>
                      <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        {waiver.throughDate}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </HomePanel>
        ) : null}

        <HomePanel
          icon="receipt"
          title={t('panels.readiness', { year: taxYear })}
          hint={t('panels.readinessHint')}
          bodyClassName="p-0"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/compliance/information-returns">{t('panels.readinessAction')}</Link>
            </Button>
          }
        >
          {overview.readiness.length === 0 ? (
            <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('panels.readinessEmpty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {overview.readiness.map((row) => (
                <li key={row.partyId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <Link
                      href={`/compliance/vendors?vendor=${row.partyId}`}
                      className="truncate text-sm font-medium text-slate-800 hover:underline dark:text-slate-100"
                    >
                      {row.vendorName}
                    </Link>
                    <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {!row.reportable
                        ? t('readiness.unflagged')
                        : !row.hasTin
                          ? t('readiness.missingTin')
                          : t('readiness.noForm')}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums text-slate-700 dark:text-slate-200">
                    {money(Number(row.paidThisYear))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </HomePanel>
      </div>

      {overview.filings.length === 0 && overview.trackedVendors === 0 && overview.configured ? (
        <div className="mt-4">
          <EmptyState title={t('empty.title')} description={t('empty.description')} />
        </div>
      ) : null}
    </ListPageLayout>
  )
}
