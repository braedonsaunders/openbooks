import { getTranslations } from 'next-intl/server'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { NewDocumentButton } from '../../../components/new-document-button'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { analyticsConfig } from '../../../lib/analytics/config'
import { arPosition } from '../../../lib/cash/ar-position'
import { ArCockpit } from './cockpit/ArCockpit'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('ar')
  return { title: t('cockpit.title') }
}

/**
 * Accounts Receivable — the receivables control center (vitals + collections
 * worklist + aging), the AP page's mirror. The invoice list is its own
 * first-class route at /ar/invoices; legacy ?view=invoices / ?doc= links
 * redirect there so old drill-throughs keep working.
 */
export default async function AR({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // Legacy tab/flyout URLs → the dedicated invoices route, params preserved.
  if (typeof sp.doc === 'string' || pickString(sp.view) === 'invoices') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'view' || v === undefined) continue
      for (const val of Array.isArray(v) ? v : [v]) qs.append(k, val)
    }
    const suffix = qs.toString()
    redirect(`/ar/invoices${suffix ? `?${suffix}` : ''}`)
  }

  const authz = await requirePermission('ar.read')
  const canCreate = can(authz, 'ar.create')
  const t = await getTranslations('ar')
  const tCommon = await getTranslations('common')

  const newButton = canCreate ? (
    <NewDocumentButton
      items={[
        { kind: 'customer_invoice', label: t('actions.newInvoice') },
        { kind: 'customer_credit', label: t('actions.newCredit') },
      ]}
      basePath="/ar/invoices"
      triggerLabel={t('actions.new')}
      creatingLabel={tCommon('actions.creating')}
      failedLabel={t('toasts.createDraftFailed')}
    />
  ) : undefined

  const tHome = await getTranslations('customers')
  const tabs = (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link href={'/customers' as any} className={tabCls(false)}>{tHome('home.title')}</Link>
      <Link href="/ar" className={tabCls(true)}>{t('cockpit.tabs.overview')}</Link>
      <Link href={'/ar/invoices' as any} className={tabCls(false)}>{t('cockpit.tabs.invoices')}</Link>
    </div>
  )

  const cfg = await analyticsConfig(authz.user.orgId, 'cashflow')
  const apSettings = { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 }
  const data = await arPosition(authz.user.orgId, 4, apSettings)

  return (
    <ListPageLayout
      className="flex h-full min-h-0 flex-col"
      header={
        <PageHeader
          title={t('cockpit.title')}
          description={t('cockpit.description')}
          actions={<div className="flex items-center gap-3">{tabs}{newButton}</div>}
        />
      }
    >
      <ArCockpit data={data} canCollect={can(authz, 'ar.pay')} />
    </ListPageLayout>
  )
}

function tabCls(active: boolean) {
  return cn(
    'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
    active
      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
      : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
  )
}
