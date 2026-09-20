import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * HR-15 rebrand: the canonical route is /inbox. This permanent redirect
 * keeps every deep link working — gate hrefs, notification bodies, email
 * links, browser history — preserving the query string (tab, kind, page)
 * so a filtered approvals link lands on the same filtered inbox.
 */
export default async function ApprovalsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(sp)) {
    if (Array.isArray(value)) {
      for (const entry of value) query.append(key, entry)
    } else if (value !== undefined) {
      query.set(key, value)
    }
  }
  // Legacy union tabs map onto the unified filters: mine/all land on the
  // full inbox, submitted (my documents pending with others) on my tasks.
  const tab = query.get('tab')
  if (tab === 'submitted') query.set('filter', 'my_tasks')
  else if (tab === 'mine' || tab === 'all') query.delete('tab')
  const suffix = query.toString()
  redirect(`/inbox${suffix ? `?${suffix}` : ''}`)
}
