import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { loadMigrationJourney } from '@/lib/migration/journey'

export const runtime = 'nodejs'

/**
 * GET /api/migration/journey[?checks=1] — the measured migration plan for the
 * migration workspace. `checks=1` also measures the cutover checks, which
 * read the ledger and both agings.
 */
export const GET = defineRoute({
  permission: 'admin.setup.manage',
  scope: 'unrestricted',
  feature: { none: 'Migration planning is organization-wide setup governed by the setup permission.' },
  handler: async ({ request, authz }) => {
    const includeChecks = new URL(request.url).searchParams.get('checks') === '1'
    const journey = await loadMigrationJourney(authz.user.orgId, { includeChecks })
    return NextResponse.json({ journey }, { headers: { 'Cache-Control': 'no-store' } })
  },
})
