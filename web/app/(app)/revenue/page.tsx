import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { EntityListView } from '../../../components/entity-list-view'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, pickString } from '../../../lib/list-params'
import { RunRecognitionButton } from './RunRecognitionButton'
import { ContractDrawer } from './ContractDrawer'
import { loadContract } from './_lib'

export const dynamic = 'force-dynamic'

export default async function Revenue({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('revenue')

  const authz = await requirePermission('ar.read')
  const canRun = can(authz, 'ar.post')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const contractId = typeof sp.contract === 'string' ? sp.contract : undefined
  const openContract =
    contractId && isUuid(contractId) ? await loadContract(contractId, orgId) : null
  const requestedReturn = pickString(sp.drawerReturn)

  return (
    <ListPageLayout
      header={<PageHeader title={t('list.title')} description={t('list.description')} actions={canRun ? <RunRecognitionButton /> : undefined} />}
    >
      <EntityListView
        recordType="revenue_contract"
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={openContract ? <ContractDrawer payload={openContract} canRun={canRun} closeHref={requestedReturn?.startsWith('/revenue') ? requestedReturn : '/revenue'} /> : null}
      />
    </ListPageLayout>
  )
}
