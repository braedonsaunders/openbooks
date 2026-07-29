import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Plus } from 'lucide-react'
import { Button, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { requirePermission, can } from '../../../lib/authz'
import { NewPaymentButton } from '../payments/NewPaymentButton'
import { PaymentsSection } from '../payments/PaymentsSection'
import { RunsSection } from '../payments/RunsSection'
import { mergeHref, pickString } from '../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Money in: customer receipts applied to open AR items — the mirror of
 * /payments, sharing its flyout and list section with side='ar'.
 */
export default async function Receipts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ar.pay')
  const t = await getTranslations('receipts')
  const sp = await searchParams
  const view = pickString(sp.view) === 'runs' ? 'runs' : 'receipts'

  return (
    <ListPageLayout
      header={
        <><PageHeader
          title={t('page.title')}
          description={t('page.description')}
          actions={
            view === 'receipts' ? <NewPaymentButton kind="customer_payment" basePath="/receipts" label={t('page.newReceipt')} /> : <Button asChild><Link href={mergeHref('/receipts', sp, { view: 'runs', newRun: '1', run: undefined }) as any}><Plus size={16} />{t('page.newCollectionRun')}</Link></Button>
          }
        /><div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"><Link href="/receipts" className={cn('rounded-md px-3 py-1.5 text-sm font-medium', view === 'receipts' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{t('page.tabs.receipts')}</Link><Link href={'/receipts?view=runs' as any} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', view === 'runs' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300')}>{t('page.tabs.collections')}</Link></div></>
      }
    >
      {view === 'receipts' ? <PaymentsSection
        sp={sp}
        basePath="/receipts"
        kind="customer_payment"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        userRole={authz.user.role}
      /> : <RunsSection sp={sp} orgId={authz.user.orgId} canApprove={can(authz, 'ar.approve')} direction="inbound" basePath="/receipts" />}
    </ListPageLayout>
  )
}
