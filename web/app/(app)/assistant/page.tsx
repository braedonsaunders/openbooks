import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { assistantSpec, loadAssistant } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('assistant')
  return { title: t('title') }
}

/** New-chat view of the assistant. */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const sp = await searchParams
  const data = await loadAssistant(sp)
  return <ModuleView spec={assistantSpec(data)} data={data} searchParams={sp} trusted />
}
