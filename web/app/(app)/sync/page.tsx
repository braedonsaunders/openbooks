import { ModuleView } from '../../../components/viewspec/module-view'
import { loadSync, syncSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * Platform → Migrations & Mirror. Tenant-configurable connections to external
 * accounting systems (NetSuite, QuickBooks Online, …): one-click full
 * migration, daily/on-demand mirror for A/B running both systems, and
 * account-by-account trial-balance verification. All data is fetched from the
 * org-scoped /api/platform/connections API, so every tenant sees only its own.
 */
export default async function PlatformPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSync()
  return <ModuleView spec={syncSpec(data)} data={data} searchParams={sp} trusted />
}
