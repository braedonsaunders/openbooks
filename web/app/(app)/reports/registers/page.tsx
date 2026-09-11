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
  return <ModuleView spec={registersSpec(data)} data={data} searchParams={sp} trusted />
}
