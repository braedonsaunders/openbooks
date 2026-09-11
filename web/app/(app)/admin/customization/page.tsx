import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomization, customizationSpec } from './view'

export const dynamic = 'force-dynamic'


export async function generateMetadata() {
  const t = await getTranslations('customization')
  return { title: t('designer.title') }
}

export default async function CustomizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCustomization(sp)
  return <ModuleView spec={customizationSpec(data)} data={data} searchParams={sp} trusted />
}
