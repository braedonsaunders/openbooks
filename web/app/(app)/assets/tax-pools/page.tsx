import { PageContainer } from '../../../../components/page-layout'
import { getAuthz, can } from '../../../../lib/authz'
import { TaxPoolsView } from './TaxPoolsView'

export const dynamic = 'force-dynamic'

export default async function TaxPoolsPage() {
  const authz = await getAuthz()
  const canRun = !!authz && (can(authz, 'assets.manage') || can(authz, '*'))
  return (
    <PageContainer>
      <TaxPoolsView canRun={canRun} />
    </PageContainer>
  )
}
