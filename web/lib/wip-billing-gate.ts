import 'server-only'

import { notFound } from 'next/navigation'
import { NextResponse } from 'next/server'
import { isFeatureEnabled } from './features'

/** Pre-billing is subordinate to Projects but does not require Time Tracking. */
export async function wipBillingEnabled(orgId: string): Promise<boolean> {
  const [projects, wipBilling] = await Promise.all([
    isFeatureEnabled(orgId, 'projects'),
    isFeatureEnabled(orgId, 'wipBilling'),
  ])
  return projects && wipBilling
}

export async function requireWipBillingFeature(orgId: string): Promise<void> {
  if (!(await wipBillingEnabled(orgId))) notFound()
}

export async function guardWipBillingFeature(orgId: string): Promise<NextResponse | null> {
  if (await wipBillingEnabled(orgId)) return null
  return NextResponse.json({ error: 'Pre-billing is turned off — enable it on Company Settings → Features' }, { status: 404 })
}
