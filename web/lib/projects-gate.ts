import 'server-only'

import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { isFeatureEnabled } from './features'

/** Page-boundary enforcement for every Projects-domain surface. Navigation
 * hiding is presentation only; this guard is the authoritative control. */
export async function requireProjectsFeature(orgId: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, 'projects'))) redirect('/admin/setup/projects')
}

/** API-boundary enforcement for every Projects-domain mutation and query. A
 * disabled module is deliberately indistinguishable from an unavailable API. */
export async function guardProjectsFeature(orgId: string): Promise<NextResponse | null> {
  if (await isFeatureEnabled(orgId, 'projects')) return null
  return NextResponse.json({ error: 'projects feature is disabled' }, { status: 404 })
}
