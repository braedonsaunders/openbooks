import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadRecordTypes, recordTypesSpec } from './view'

export const dynamic = 'force-dynamic'



export default async function RecordTypes({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadRecordTypes(sp)
  return <ModuleView spec={recordTypesSpec(data)} data={data} searchParams={sp} trusted />
}

/** Plain-JSON shape for the client drawer (see RecordTypePayload). */
