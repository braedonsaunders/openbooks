import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { loadInsurance } from './_data'
import { InsuranceWorkspace, NewPolicyButton } from './InsuranceWorkspace'

export const dynamic = 'force-dynamic'

/** Asset insurance: policies, covered assets, renewals and insured value against net book value. */
export default async function AssetInsurancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const [data, t] = await Promise.all([loadInsurance(sp), getTranslations('assets')])
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('insurance.title')}
          description={t('insurance.description')}
          actions={data.canMaintain ? <NewPolicyButton data={data} /> : undefined}
        />
      }
    >
      <InsuranceWorkspace data={data} currentParams={sp} />
    </ListPageLayout>
  )
}
