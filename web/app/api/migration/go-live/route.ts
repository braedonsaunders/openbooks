import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { loadJourneyFacts, measureCutoverChecks } from '@/lib/migration/journey'
import { recordGoLive } from '@/lib/migration/plan'

export const runtime = 'nodejs'

const body = z.object({
  confirmation: z.string().trim().min(5).max(500),
}).strict()

/**
 * POST /api/migration/go-live — measure the cutover checks and, only when
 * every required check passes, record that these books are live from the
 * cutover date with the measured evidence. The same governed command the
 * migration assistant runs: it refuses a mirror path, a missing cutover
 * date, and any failing or unmeasured required check, and records once.
 */
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  scope: 'unrestricted',
  feature: { none: 'Migration planning is organization-wide setup governed by the setup permission.' },
  body,
  handler: async ({ authz, body: request }) => {
    const orgId = authz.user.orgId
    const { after } = await recordGoLive(
      { orgId, id: authz.user.id },
      async () => measureCutoverChecks(orgId, await loadJourneyFacts(orgId)),
      `went live: ${request.confirmation}`,
    )
    return NextResponse.json({ goLive: after.goLive })
  },
})
