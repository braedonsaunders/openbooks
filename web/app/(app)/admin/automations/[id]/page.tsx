import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import { automationBuilderSpec, loadAutomationBuilder } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.automations')
  return { title: t('builder.pageTitle') }
}

export default async function AutomationBuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadAutomationBuilder(id)
  return <ModuleView spec={automationBuilderSpec(data)} data={data} searchParams={sp} trusted />
}
