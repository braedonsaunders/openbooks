import { getTranslations } from 'next-intl/server'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadCompliance, complianceSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('compliance')
  return { title: t('title') }
}

/**
 * Subcontractor compliance cockpit — the four questions a general contractor's
 * office asks every morning, in the order money is at risk:
 *
 *   1. Whose money is blocked right now, and how much of it?
 *   2. What lapses this month?
 *   3. Which lien waivers are still outstanding?
 *   4. Are we ready to file 1099s?
 *
 * Read-only by design: every action lives on the record it belongs to, so there
 * is one editable home per fact.
 */
export default async function ComplianceHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadCompliance(sp)
  return <ModuleView spec={complianceSpec(data)} data={data} searchParams={sp} trusted />
}
