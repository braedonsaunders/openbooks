import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMatch, matchSpec } from './view'


export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('match.title') }
}

export default async function MatchBankData({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp0 = await searchParams
  const data = await loadMatch(sp0)
  return <ModuleView spec={matchSpec(data)} data={data} searchParams={sp0} trusted />
}
