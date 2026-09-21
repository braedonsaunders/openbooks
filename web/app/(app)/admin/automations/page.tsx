import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { automationsSpec, loadAutomations } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.automations')
  return { title: t('title') }
}

export default async function Automations({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAutomations(sp)
  return <ModuleView spec={automationsSpec(data)} data={data} searchParams={sp} trusted />
}
