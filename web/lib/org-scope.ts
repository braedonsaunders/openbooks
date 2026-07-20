import 'server-only'
import { sql } from 'drizzle-orm'
import { cache } from 'react'
import { currentUser } from './auth'
import { db } from '@openbooks/engine/src/db.ts'

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

async function requestOrgIdFromSession(): Promise<string | null> {
  try {
    const r = (await db.execute(sql`select nullif(current_setting('app.current_org', true), '') as org_id`)) as {
      rows: { org_id: string | null }[]
    }
    return r.rows[0]?.org_id ?? null
  } catch {
    return null
  }
}

export async function resolveOrgId(orgId?: string | null): Promise<string> {
  if (orgId) return orgId
  try {
    return await requestOrgId()
  } catch {
    const sessionOrg = await requestOrgIdFromSession()
    if (sessionOrg) return sessionOrg
    throw new Error('active organization is required')
  }
}
