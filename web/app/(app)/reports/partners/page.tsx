import { ModuleView } from '../../../../components/viewspec/module-view'
import { requireStatementAccess } from '../../../../lib/report-authz'
import { loadPartners, partnersSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * The partner ageing report. The page is a loader and a spec: `./view.ts`
 * resolves the data, and `ModuleView` renders it.
 *
 * This page carried two implementations during the conversion — the original
 * JSX and a `?__viewspec=1` branch — so the conformance harness could diff
 * them against the same request and the same data. That comparison is done;
 * the native branch is gone and its output is recorded in
 * `tests/viewspec-golden`, which is what the harness diffs against now.
 */
export default async function Partners({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  // The statement's own read grant (ledger, receivables or payables), beyond reports.read.
  await requireStatementAccess('partners', sp)
  const data = await loadPartners(sp)
  return <ModuleView spec={partnersSpec(data)} data={data} searchParams={sp} trusted />
}
