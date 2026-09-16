import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadContinuousClose, continuousCloseSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('continuousClose')
  return { title: t('metaTitle') }
}

/**
 * The Agent Workbench home moved to /agents (all packs, ranked). This route
 * redirects there — except its reports tab, which stays until the morning
 * briefing moves it. ?item= deep links (tools, chat citations, bookmarks)
 * map onto the workbench drawer, so nothing breaks.
 */
export default async function ContinuousClosePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const tab = sp.tab
  const tabValue = Array.isArray(tab) ? tab[0] : tab
  if (tabValue !== 'reports') {
    const params = new URLSearchParams()
    const item = sp.item
    const itemValue = Array.isArray(item) ? item[0] : item
    if (typeof itemValue === 'string' && itemValue) params.set('item', itemValue)
    const query = params.toString()
    redirect(`/agents${query ? `?${query}` : ''}`)
  }
  const data = await loadContinuousClose(sp)
  return <ModuleView spec={continuousCloseSpec(data)} data={data} searchParams={sp} trusted />
}
