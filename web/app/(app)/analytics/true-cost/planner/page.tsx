import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * The former true-cost planner route. It rendered the same read-only
 * dashboard as /analytics/true-cost — the interactive recovery
 * (absorption) and selling planning tabs live there, not here — so a
 * distinct planner page promised modelling it never owned. It now
 * redirects to the dashboard, keeping the query, so bookmarks and the
 * old report link land on the planning that exists.
 */
export default async function TrueCostPlannerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) if (value) query.set(key, value)
  const qs = query.toString()
  redirect(`/analytics/true-cost${qs ? `?${qs}` : ''}`)
}
