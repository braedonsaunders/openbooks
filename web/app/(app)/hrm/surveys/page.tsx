import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadSurveysPage, surveysSpec, surveysTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await surveysTitle() }
}

/**
 * Surveys tab: authoring plus aggregate results with minimum-group
 * suppression. Renders only when hrm and hrmSurveys are on and the
 * actor holds hrm.surveys.manage — the loader 404s otherwise.
 */
export default async function SurveysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSurveysPage(sp)
  return <ModuleView spec={surveysSpec(data)} data={data} searchParams={sp} trusted />
}
