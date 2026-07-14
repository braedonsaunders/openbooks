import Link from 'next/link'
import { cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { requirePermission } from '../../../lib/authz'
import { pickString } from '../../../lib/list-params'
import { NewPaymentButton } from './NewPaymentButton'
import { PaymentsSection } from './PaymentsSection'
import { RunsSection } from './RunsSection'

export const dynamic = 'force-dynamic'

/**
 * Money out: vendor payments (with open-item application) and EFT payment
 * runs. ?view=runs switches to the run builder + run list; ?payment= and
 * ?run= open the respective flyouts.
 */
export default async function Payments({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('ap.pay')
  const sp = await searchParams
  const view = pickString(sp.view) === 'runs' ? 'runs' : 'payments'

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Payments"
            description="Vendor payments applied to open bills, and EFT payment runs exported as CPA-005 files."
            actions={
              view === 'payments' ? (
                <NewPaymentButton kind="vendor_payment" basePath="/payments" label="New payment" />
              ) : undefined
            }
          />
          <ViewTabs view={view} />
        </>
      }
    >
      {view === 'payments' ? (
        <PaymentsSection sp={sp} basePath="/payments" kind="vendor_payment" orgId={authz.user.orgId} />
      ) : (
        <RunsSection sp={sp} orgId={authz.user.orgId} />
      )}
    </ListPageLayout>
  )
}

function ViewTabs({ view }: { view: 'payments' | 'runs' }) {
  const tab = (active: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      active
        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
        : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
    )
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link href="/payments" className={tab(view === 'payments')}>
        Payments
      </Link>
      <Link href={'/payments?view=runs' as any} className={tab(view === 'runs')}>
        Payment runs
      </Link>
    </div>
  )
}
