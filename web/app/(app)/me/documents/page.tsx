import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeDocumentsPage, meDocumentsSpec, meDocumentsTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meDocumentsTitle() }
}

/**
 * Me documents — own documents with inline sign/acknowledge plus the
 * subject-access export request. Renders when hrm and hrmDocuments
 * are on — the loader 404s otherwise.
 */
export default async function MeDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadMeDocumentsPage(sp)
  return <ModuleView spec={meDocumentsSpec(data)} data={data} searchParams={sp} trusted />
}
