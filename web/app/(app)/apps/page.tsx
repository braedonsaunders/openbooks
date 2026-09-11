import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAppsLauncher, appsLauncherSpec } from './view'

export const runtime = 'nodejs'

/** App launcher — searchable, paginated access to the org's installed Apps. */
export default async function AppsLauncherPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAppsLauncher(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={appsLauncherSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
