import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRegisters, registersSpec } from './view'

export const dynamic = 'force-dynamic'

export default async function RegistersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRegisters(sp)
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={registersSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
