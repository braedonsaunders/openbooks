import { NextResponse } from 'next/server'
import { getLocale } from 'next-intl/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { getAuthz } from '@/lib/authz'
import { withAuthzContext } from '@/lib/authz-context'
import { refreshDashboardGroups } from '@/app/(app)/dashboard/_projection'
import { resolveAllowedWidgetIds } from '@/app/(app)/dashboard/widget-features'

export const runtime = 'nodejs'

const BODY = z
  .object({
    groups: z.array(z.array(z.string().min(1).max(128)).min(1).max(64)).min(1).max(64),
  })
  .strict()

/**
 * Rebuild the dashboard tile groups the signed-in person was shown from an
 * older projection. Each group is rebuilt only for the widgets their grants
 * and the organization's features allow, under their own authority, and the
 * dashboard re-renders from the rebuilt projections.
 */
export const POST = defineRoute({
  public: 'session',
  body: BODY,
  handler: async ({ body }) => {
    const authz = await getAuthz()
    if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    return withAuthzContext(authz, async () => {
      const [allowed, locale] = await Promise.all([resolveAllowedWidgetIds(authz), getLocale()])
      const rebuilt = await refreshDashboardGroups(authz, body.groups, allowed, locale)
      return NextResponse.json({ rebuilt }, { headers: { 'Cache-Control': 'private, no-store' } })
    })
  },
})
