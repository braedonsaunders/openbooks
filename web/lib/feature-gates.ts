import 'server-only'
import { notFound } from 'next/navigation'
import { NextResponse } from 'next/server'
import type { Authz } from './authz'
import { guardPermission } from './authz'
import { isFeatureEnabled } from './features'

/** Page boundary for an organization-owned optional capability. */
export async function requireFeatureEnabled(orgId: string, featureKey: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, featureKey))) notFound()
}

/** Permission and feature enforcement for optional-capability APIs. */
export async function guardFeaturePermission(
  permission: string,
  featureKey: string,
): Promise<Authz | NextResponse> {
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, featureKey))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return gate
}
