import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ScanLine } from 'lucide-react'
import { Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { ModuleHomeTabs } from '../../../components/module-home/ui'
import { groupTabs } from '../../../components/module-home/group-tabs'
import { NewDocumentButton } from '../../../components/new-document-button'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { analyticsConfig } from '../../../lib/analytics/config'
import { apPosition } from '../../../lib/cash/ap-position'
import { ApCockpit } from './cockpit/ApCockpit'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ap')
  return { title: t('cockpit.title') }
}

/**
 * Accounts Payable — the payables control center (vitals + pay-run planner +
 * aging). The bills list is its own first-class route at /ap/bills; legacy
 * ?view=bills / ?doc= links redirect there so old drill-throughs keep working.
 */
export default async function AP({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // Legacy tab/flyout URLs → the dedicated bills route, params preserved.
  if (typeof sp.doc === 'string' || pickString(sp.view) === 'bills') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'view' || v === undefined) continue
      for (const val of Array.isArray(v) ? v : [v]) qs.append(k, val)
    }
    const suffix = qs.toString()
    redirect(`/ap/bills${suffix ? `?${suffix}` : ''}`)
  }

  const authz = await requirePermission('ap.read')
  const canCreate = can(authz, 'ap.create')
  const t = await getTranslations('ap')
  const tCommon = await getTranslations('common')

  const newButton = canCreate ? (
    <NewDocumentButton
      items={[
        { kind: 'vendor_bill', label: t('actions.newBill') },
        { kind: 'vendor_credit', label: t('actions.newCredit') ?? t('actions.newBill') },
      ]}
      basePath="/ap/bills"
      triggerLabel={t('actions.newBill')}
      creatingLabel={tCommon('actions.creating')}
      failedLabel={t('toasts.createDraftFailed')}
    />
  ) : undefined
  const headerActions = (
    <div className="flex items-center gap-2">
      <Button variant="outline" asChild>
        <Link href="/ap/capture"><ScanLine size={14} />{t('actions.capture')}</Link>
      </Button>
      {newButton}
    </div>
  )

  const tabs = <ModuleHomeTabs tabs={await groupTabs('purchasing', '/ap')} />

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const data = await apPosition(authz.user.orgId, 4, apSettings)

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('cockpit.title')}
          description={t('cockpit.description')}
          actions={<div className="flex items-center gap-3">{tabs}{headerActions}</div>}
        />
      }
    >
      <ApCockpit data={data} canConfigure={can(authz, 'admin.setup.manage')} canPay={can(authz, 'ap.pay')} />
    </ListPageLayout>
  )
}
