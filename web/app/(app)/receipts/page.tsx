import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { requirePermission, can } from '../../../lib/authz'
import { NewPaymentButton } from '../payments/NewPaymentButton'
import { PaymentsSection } from '../payments/PaymentsSection'

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

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('page.title')}
          description={t('page.description')}
          actions={
            <NewPaymentButton kind="customer_payment" basePath="/receipts" label={t('page.newReceipt')} />
          }
        />
      }
    >
      <PaymentsSection
        sp={sp}
        basePath="/receipts"
        kind="customer_payment"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        userRole={authz.user.role}
      />
    </ListPageLayout>
  )
}
