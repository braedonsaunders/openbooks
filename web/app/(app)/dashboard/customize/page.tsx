import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadCustomizeDashboard, customizeDashboardSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('dashboard')
  return { title: t('customize.title') }
}

export default async function CustomiseDashboardPage({
  searchParams,
}: {
  // Optional: this route natively takes no props. The conversion needs a query
  // flag, and threading it through must not make the prop mandatory.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  const data = await loadCustomizeDashboard()
  if (!data) return null
  return <ModuleView spec={customizeDashboardSpec(data)} data={data} searchParams={sp} trusted />
}
