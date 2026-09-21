import { ModuleView } from '../../../../components/viewspec/module-view'
import { anomalyChecksTitle, loadAnomalyChecksPage, anomalyChecksSpec } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await anomalyChecksTitle() }
}

/**
 * Payroll checks — stat tiles, filter chips, the flags table and the
 * flag drawer. Blocking flags refuse the pay-run finalize while open.
 */
export default async function AnomalyChecksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const raw = await searchParams
  const sp: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw)) {
    sp[key] = Array.isArray(value) ? value[0] : value
  }
  const data = await loadAnomalyChecksPage(sp)
  return <ModuleView spec={anomalyChecksSpec(data)} data={data} searchParams={sp} trusted />
}
