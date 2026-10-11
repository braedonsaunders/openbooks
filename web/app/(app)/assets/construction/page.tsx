import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { loadConstruction } from './_data'
import { ConstructionWorkspace, NewCipButton } from './ConstructionWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Construction in progress: records accumulating linked GL cost, their
 * governed capitalization into assets, and the subledger's reconciliation to
 * the CIP accounts.
 */
export default async function ConstructionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const [data, t] = await Promise.all([loadConstruction(sp), getTranslations('assets')])
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('construction.title')}
          description={t('construction.description')}
          actions={data.canCapitalize ? <NewCipButton data={data} /> : undefined}
        />
      }
    >
      <ConstructionWorkspace data={data} currentParams={sp} />
    </ListPageLayout>
  )
}
