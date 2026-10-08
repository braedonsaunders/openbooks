import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadProjectBudgetReport, projectBudgetSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('reports.projectBudget')
  return { title: t('title') }
}

/**
 * Project budget vs actual: each task's original (sold) budget, current
 * budget and actual hours and cost as of a date. The loader redirects to the
 * Features remedy while Projects is off.
 */
export default async function ProjectBudgetVsActualReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadProjectBudgetReport(sp)
  return <ModuleView spec={projectBudgetSpec(data)} data={data} searchParams={sp} trusted />
}
