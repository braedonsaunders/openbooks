import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadPspUnmatched, pspUnmatchedSpec } from './view'

/**
 * Banking → Payouts → Unmatched lines: every settlement line no document
 * claims yet, with the proposal chip on each row and approve in the drawer.
 */
export default async function PspUnmatchedPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>
} = {}) {
  const sp = (await searchParams) ?? {}
  const data = await loadPspUnmatched(sp)
  return <ModuleView spec={pspUnmatchedSpec(data)} data={data} searchParams={sp} trusted />
}
