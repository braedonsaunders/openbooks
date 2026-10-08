import 'server-only'

import { notFound } from 'next/navigation'
import { NextResponse } from 'next/server'
import { isFeatureEnabled } from './features'

/** Pre-billing is subordinate to Projects but does not require Time Tracking. */
export async function preBillingEnabled(orgId: string): Promise<boolean> {
  const [projects, preBilling] = await Promise.all([
    isFeatureEnabled(orgId, 'projects'),
    isFeatureEnabled(orgId, 'preBilling'),
  ])
  return projects && preBilling
}

export async function requirePreBillingFeature(orgId: string): Promise<void> {
  if (!(await preBillingEnabled(orgId))) notFound()
}

export async function guardPreBillingFeature(orgId: string): Promise<NextResponse | null> {
  if (await preBillingEnabled(orgId)) return null
  return NextResponse.json({ error: 'Pre-billing is turned off — enable it on Company Settings → Features' }, { status: 404 })
}
