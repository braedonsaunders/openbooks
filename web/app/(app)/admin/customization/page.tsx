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
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={customizationSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
