import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { loadProposals } from './_data'
import { ProposalsWorkspace } from './ProposalsWorkspace'

export const dynamic = 'force-dynamic'

/**
 * The asset proposal queue: posted purchase lines the capitalization rules
 * flagged, to accept as assets, components or construction in progress, or
 * reject with a reason.
 */
export default async function AssetProposalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const [data, t] = await Promise.all([loadProposals(sp), getTranslations('assets')])
  return (
    <ListPageLayout header={<PageHeader title={t('proposals.title')} description={t('proposals.description')} />}>
      <ProposalsWorkspace data={data} currentParams={sp} />
    </ListPageLayout>
  )
}
