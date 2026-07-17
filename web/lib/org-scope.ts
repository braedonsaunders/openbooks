import 'server-only'
import { cache } from 'react'
import { currentUser } from './auth'

/**
 * Resolve the tenant id before querying `orgs`, which cannot be protected by
 * the normal org_id RLS policy because it is the tenant root table itself.
 *
 * Calling currentUser also establishes the request's RLS scope before report
 * pages issue any business-data queries. This matters because Next can render a
 * layout and its page concurrently; a page must not assume the layout already
 * initialized the tenant context. Trusted internal jobs pass their org id.
 */
const requestOrgId = cache(async (): Promise<string> => {
  const user = await currentUser()
  if (!user) throw new Error('active organization is required')
  return user.orgId
})

export async function resolveOrgId(orgId?: string | null): Promise<string> {
  return orgId ?? requestOrgId()
}
