import { ModuleView } from '../../../../components/viewspec/module-view'
import { documentsSpec, documentsTitle, loadDocumentsPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await documentsTitle() }
}

/**
 * Documents tab: the HR document register with e-sign actions, the
 * generate dialog, and the rehomed template/category/retention setup.
 * Renders only when hrm and hrmDocuments are on and the actor holds
 * hrm.documents.read — the loader 404s otherwise.
 */
export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadDocumentsPage(sp)
  return <ModuleView spec={documentsSpec(data)} data={data} searchParams={sp} trusted />
}
