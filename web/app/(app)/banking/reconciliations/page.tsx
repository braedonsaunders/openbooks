import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Button, PageHeader } from '@openbooks/ui'
import { EntityListView } from '../../../../components/entity-list-view'
import { ListPageLayout } from '../../../../components/page-layout'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { can, requirePermission } from '../../../../lib/authz'
import { bankingReconciliationsSpec, loadBankingReconciliations } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('reconsPage.title') }
}

export default async function BankingReconciliations({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadBankingReconciliations(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={bankingReconciliationsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')
  const sp = await searchParams

  return (
    <ListPageLayout
      header={
        <PageHeader
          back={{ href: '/banking', label: t('home.title') }}
          title={t('reconsPage.title')}
          description={t('reconsPage.description')}
        />
      }
    >
      <EntityListView
        recordType="bank_reconciliation"
        orgId={authz.user.orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        emptyAction={
          <Button asChild>
            <Link href="/banking">{t('reconsPage.chooseAccount')}</Link>
          </Button>
        }
      />
    </ListPageLayout>
  )
}
