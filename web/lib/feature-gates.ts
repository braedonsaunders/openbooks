import 'server-only'
import { NextResponse } from 'next/server'
import type { Authz } from './authz'
import { guardPermission } from './authz'
import { isFeatureEnabled } from './features'
import { featureRequiredHref } from './gate-targets'
import { notFound } from "@/lib/api/responses";

/**
 * Page boundary for an organization-owned optional capability. A disabled
 * feature explains itself on the feature-required page (which feature, where
 * to turn it on) instead of 404ing as if the route were a typo.
 */

export async function requireFeatureEnabled(orgId: string, featureKey: string): Promise<void> {
  if (!(await isFeatureEnabled(orgId, featureKey))) {
    // Navigation belongs to the page boundary; API feature guards also run
    // in native background commands without a client router runtime.
    const { redirect } = await import('next/navigation')
    redirect(featureRequiredHref(featureKey))
  }
}

/**
 * API boundary that combines permission and feature enforcement. Disabled
 * features return 404 so hidden modules do not expose an alternate API surface.
 */
export async function guardFeaturePermission(
  permission: string,
  featureKey: string,
): Promise<Authz | NextResponse> {
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, featureKey))) {
    return notFound("record")
  }
  return gate
}
