import { ModuleView } from '../../../components/viewspec/module-view'
import { loadMePage, meSpec, meTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meTitle() }
}

/**
 * Me overview — the person's workspace landing: employment summary, open
 * steps, pending requests, balances, and the extension rail. Renders only
 * when the hrm feature gate is on and the actor holds hrm.self.read — the
 * view 404s otherwise.
 */
export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMePage(sp)
  return <ModuleView spec={meSpec(data)} data={data} searchParams={sp as Record<string, string | string[] | undefined>} trusted />
}
