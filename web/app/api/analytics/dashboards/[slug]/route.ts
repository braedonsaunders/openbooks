import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { withAuthzContext } from '@/lib/authz-context'
import { notFound } from '@/lib/api/responses'
import { ANALYTICS_TABS, type AnalyticsSlug } from '@/lib/analytics/dashboard-tabs'
import { readAnalyticsDashboard } from '@/lib/analytics/dashboard-reader'
import { ANALYTICS_DASHBOARD_MAP } from '@/lib/analytics/dashboard-catalog'
import { analyticsDashboardAvailable } from '@/lib/analytics/dashboard-access'

export const runtime = 'nodejs'
export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: 'The shared dashboard reader enforces the selected dashboard Company Features and scope requirements.' },
  params: z.object({ slug: z.string().min(1).max(64) }),
  handler: async ({ authz, params, request }) => withAuthzContext(authz, async () => {
    if (!Object.hasOwn(ANALYTICS_TABS, params.slug)) return notFound('analytics dashboard')
    const slug = params.slug as AnalyticsSlug
    if (!await analyticsDashboardAvailable(authz, ANALYTICS_DASHBOARD_MAP[slug]!)) return notFound('analytics dashboard')
    const sp = Object.fromEntries(new URL(request.url).searchParams.entries())
    const tabs: readonly string[] = ANALYTICS_TABS[slug]
    if (sp.tab && !tabs.includes(sp.tab)) return Response.json({ error: 'Select a supported analytics dashboard tab.' }, { status: 400 })
    const started = performance.now()
    const result = await readAnalyticsDashboard(slug, sp)
    if ('refusal' in result && result.refusal) return Response.json({ error: result.refusal }, { status: 422 })
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store', 'Server-Timing': `analytics;dur=${(performance.now() - started).toFixed(1)}` } })
  }),
})
