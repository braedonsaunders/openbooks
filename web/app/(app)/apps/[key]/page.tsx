import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAppRuntime, appRuntimeSpec } from './view'

export const runtime = 'nodejs'

export default async function AppRuntimePage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  // Optional: this route natively takes only `params`. The conversion needs a
  // query flag, and threading it through must not make the prop mandatory for
  // any caller that renders the component directly.
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { key } = await params
  const sp = (await searchParams) ?? {}
  const data = await loadAppRuntime(key)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={appRuntimeSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
