import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Plus } from 'lucide-react'
import { Button, cn, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { requirePermission, can } from '../../../lib/authz'
import { mergeHref, pickString } from '../../../lib/list-params'
import { NewPaymentButton } from './NewPaymentButton'
import { PaymentsSection } from './PaymentsSection'
import { RunsSection } from './RunsSection'
import { ViewTabs } from './sections'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadPayments, paymentsSpec } from './view'

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
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadPayments(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={paymentsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('ap.pay')
  const t = await getTranslations('payments')
  const sp = await searchParams
  const view = pickString(sp.view) === 'runs' ? 'runs' : 'payments'

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('page.title')}
            description={t('page.description')}
            actions={
              view === 'payments' ? (
                <NewPaymentButton kind="vendor_payment" basePath="/payments" label={t('page.newPayment')} />
              ) : (
                <Button asChild>
                  <Link href={(mergeHref('/payments', sp, { view: 'runs', newRun: '1', run: undefined }))}>
                    <Plus size={16} />
                    {t('page.newRun')}
                  </Link>
                </Button>
              )
            }
          />
          <ViewTabs
            view={view}
            labels={{ payments: t('page.tabs.payments'), runs: t('page.tabs.runs') }}
          />
        </>
      }
    >
      {view === 'payments' ? (
        <PaymentsSection
        authz={authz}
          sp={sp}
          basePath="/payments"
          kind="vendor_payment"
          orgId={authz.user.orgId}
          userId={authz.user.id}
          canManage={can(authz, 'admin.customization.manage')}
          userRoles={authz.user.roles.map(({ key }) => key)}
        />
      ) : (
        <RunsSection sp={sp} authz={authz} canApprove={can(authz, 'ap.approve')} />
      )}
    </ListPageLayout>
  )
}
