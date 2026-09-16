import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAgents, agentsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('agents')
  return { title: t('metaTitle') }
}

/**
 * The Agent Workbench home: one ranked inbox across every readable agent
 * pack, with keyboard triage, bulk actions, and the shared finding drawer.
 * Pack configuration lives in Setup → Agents; /continuous-close redirects
 * here (its reports tab stays put until the briefing moves it).
 */
export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadAgents(sp)
  return <ModuleView spec={agentsSpec(data)} data={data} searchParams={sp} trusted />
}
