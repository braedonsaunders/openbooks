import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadMeSurveysPage, meSurveysSpec, meSurveysTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await meSurveysTitle() }
}

/**
 * Me open surveys — unanswered invitations with the respond link.
 * Renders when hrm and hrmSurveys are on — the loader 404s otherwise.
 */
export default async function MeSurveysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  void sp
  const data = await loadMeSurveysPage()
  return <ModuleView spec={meSurveysSpec(data)} data={data} searchParams={sp} trusted />
}
