import { PlatformHub } from '@braedonsaunders/appkit-superadmin/react'
import { ShieldCheck } from 'lucide-react'
import { platformSummary } from '../../../lib/platform-admin'
import { OPENBOOKS_PLATFORM_NAV } from '../../../lib/platform-console'

export const dynamic = 'force-dynamic'

export default async function PlatformPage() {
  const summary = await platformSummary()
  const tiles = OPENBOOKS_PLATFORM_NAV.tiles.map((tile) => {
    if (tile.id === 'tenants') {
      return {
        ...tile,
        stat: summary.organizations.toLocaleString(),
        detail: `${summary.productionOrganizations} production · ${summary.environments} non-production`,
      }
    }
    if (tile.id === 'users') {
      return {
        ...tile,
        stat: summary.activeUsers.toLocaleString(),
        detail: `${summary.superAdmins} super administrator${summary.superAdmins === 1 ? '' : 's'}`,
      }
    }
    if (tile.id === 'access') {
      return {
        ...tile,
        stat: summary.activeGrants.toLocaleString(),
        detail: 'Active explicit grants',
      }
    }
    if (tile.id === 'emailLog') {
      return {
        ...tile,
        stat: summary.failedEmails.toLocaleString(),
        detail: 'Failed deliveries requiring attention',
      }
    }
    return tile
  })

  return (
    <PlatformHub
      title="Platform"
      description="Platform-wide operations, identities, access controls, and delivery evidence."
      tiles={tiles}
      notice={
        <div className="rounded-xl border border-warning/30 bg-warning-subtle/70 p-4">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-warning-subtle text-warning ring-1 ring-warning/20">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="text-sm font-semibold text-fg">Platform workspace</p>
              <p className="mt-0.5 text-sm text-fg-muted">
                This workspace bypasses organization boundaries for authorized operators. Every
                access-control mutation is validated and written to the immutable audit trail.
              </p>
            </div>
          </div>
        </div>
      }
    />
  )
}
