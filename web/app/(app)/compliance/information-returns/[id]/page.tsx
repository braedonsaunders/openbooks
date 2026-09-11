import { getTranslations } from 'next-intl/server'
import { isUuid } from '../../../../../lib/list-params'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { filingDetailSpec, loadFilingDetail } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations('compliance')
  const { id } = await params
  if (!isUuid(id)) return { title: t('informationReturns.title') }
  return { title: t('informationReturns.title') }
}

/**
 * One filing's recipient worksheet: the computed box amounts, the adjustments a
 * person made and why, and the actions that move the filing forward.
 *
 * The worksheet is the artefact an accountant reviews before anything is
 * transmitted, so the ledger figure and the filed figure are both visible on
 * every row — never one silently replacing the other.
 */
export default async function FilingDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  // Optional: this route natively takes only `params`.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = (await searchParams) ?? {}
  const { id } = await params
  const data = await loadFilingDetail(id)
  return <ModuleView spec={filingDetailSpec(data)} data={data} searchParams={sp} trusted />
}
