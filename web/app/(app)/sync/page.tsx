import { PageContainer } from '../../../components/page-layout'
import { PlatformClient } from './PlatformClient'

export const dynamic = 'force-dynamic'

/**
 * Platform → Migrations & Mirror. Tenant-configurable connections to external
 * accounting systems (NetSuite, QuickBooks Online, …): one-click full
 * migration, daily/on-demand mirror for A/B running both systems, and
 * account-by-account trial-balance verification. All data is fetched from the
 * org-scoped /api/platform/connections API, so every tenant sees only its own.
 */
export default function PlatformPage() {
  return (
    <PageContainer>
      <PlatformClient />
    </PageContainer>
  )
}
