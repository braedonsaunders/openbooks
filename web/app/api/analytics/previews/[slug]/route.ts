import { z } from 'zod'
import { withAuthzContext } from '@/lib/authz-context'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { ANALYTICS_DASHBOARD_MAP } from '@/lib/analytics/dashboard-catalog'
import { analyticsDashboardAvailable } from '@/lib/analytics/dashboard-access'
import { analyticsDashboardPreview } from '@/lib/analytics/dashboard-preview'

export const runtime = 'nodejs'
export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: 'Analytics previews inherit each source dashboard feature gate in the handler.' },
  params: z.object({ slug: z.string().min(1).max(64) }),
  handler: async ({ authz, params, request }) => withAuthzContext(authz, async () => {
    const dashboard = ANALYTICS_DASHBOARD_MAP[params.slug]
    if (!dashboard || !(await analyticsDashboardAvailable(authz, dashboard))) return notFound('analytics dashboard')
    const sp = Object.fromEntries(new URL(request.url).searchParams.entries())
    const started = performance.now()
    const preview = await analyticsDashboardPreview(dashboard, sp, authz.user.orgId)
    return Response.json(preview, { headers: { 'Cache-Control': 'private, no-store', 'Server-Timing': `analytics;dur=${(performance.now() - started).toFixed(1)}` } })
  }),
})
