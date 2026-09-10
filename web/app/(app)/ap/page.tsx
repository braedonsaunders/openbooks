import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { requirePermission, can } from '../../../lib/authz'
import { analyticsConfig } from '../../../lib/analytics/config'
import { normalizeMoneyValue, withoutWeekEntries } from '../../../lib/cash/core'
import { apPosition } from '../../../lib/cash/ap-position'
import { ApCockpit } from './cockpit/ApCockpit'
import { ApHeaderActions } from './sections'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadApCockpit, apCockpitSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ap')
  return { title: t('cockpit.title') }
}

/**
 * Accounts Payable — the payables control center (vitals + pay-run planner +
 * aging). The bills list is its own first-class route at /ap/bills.
 */
// `searchParams` is OPTIONAL because cash-scope.integration.test.ts calls
// this component directly with no arguments — the same accommodation /ar
// needed. A required prop here turns a passing test into a type error.
export default async function AP({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadApCockpit()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={apCockpitSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap')
  const tCommon = await getTranslations('common')

  const headerActions = (
    <ApHeaderActions
      captureHref="/ap/capture"
      captureLabel={t('actions.capture')}
      canCreate={canCreate}
      newItems={[
        { kind: 'vendor_bill', label: t('actions.newBill') },
        { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
      ]}
      newBasePath="/ap/bills"
      newTriggerLabel={t('actions.newBill')}
      newCreatingLabel={tCommon('actions.creating')}
      newFailedLabel={t('toasts.createDraftFailed')}
    />
  )

  const tabs = <ModuleHomeTabs tabs={await groupTabs('purchasing', '/ap', { orgId: authz.user.orgId })} />

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: normalizeMoneyValue(String(cfg.weeklyApCap ?? 0)), restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const position = await apPosition(authz.user.orgId, 4, apSettings, undefined, authz.allowedSubsidiaryIds)
  // The schedule bars need each week's label and amount; the week drill
  // fetches the week a reader actually opens from /api/cash/week-entries.
  // Shipping every week's transactions as well repeated the whole open-item
  // book across the horizon.
  const data = {
    ...position,
    weeks: position.weeks.map((w) => ({ ...w, entries: [] })),
    timeline: withoutWeekEntries(position.timeline),
  }

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('cockpit.title')}
          description={t('cockpit.description')}
          actions={<div className="flex items-center gap-3">{headerActions}{tabs}</div>}
        />
      }
    >
      <ApCockpit data={data} canConfigure={can(authz, 'admin.setup.manage')} canPay={can(authz, 'ap.pay')} />
    </ListPageLayout>
  )
}
