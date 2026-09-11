import { ModuleView } from '../../../components/viewspec/module-view'
import { loadAssets, assetsSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function Assets({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadAssets(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={assetsSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
