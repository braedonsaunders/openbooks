import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAnalytics, analyticsSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('analytics.hub')
  return { title: t('title') }
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  const data = await loadAnalytics()
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={analyticsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
