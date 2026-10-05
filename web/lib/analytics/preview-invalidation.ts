import 'server-only'
import { advanceSharedCacheVersion } from '@openbooks/jobs/read-cache'

export const ANALYTICS_PREVIEW_FRESHNESS_MS = 30_000
const MAX_ORGANIZATIONS = 256
const localVersions = new Map<string, { version: number; changedAt: number }>()
export const analyticsLocalPreviewVersion = (orgId: string) => localVersions.get(orgId)?.version ?? 0

export const analyticsPreviewVersionKey = (orgId: string) => `openbooks:analytics:version:${orgId}`

/** Successful API mutations invalidate once per 30-second freshness window.
 * Bursts and other writers remain covered by the same bounded expiry; cards
 * expose their calculation time. Detailed reports always read their sources. */
export async function invalidateAnalyticsPreviews(orgId: string): Promise<void> {
  const previous = localVersions.get(orgId)
  if (previous && Date.now() - previous.changedAt < ANALYTICS_PREVIEW_FRESHNESS_MS) return
  if (localVersions.size >= MAX_ORGANIZATIONS && !localVersions.has(orgId)) localVersions.delete(localVersions.keys().next().value!)
  localVersions.set(orgId, { version: (previous?.version ?? 0) + 1, changedAt: Date.now() })
  await advanceSharedCacheVersion(analyticsPreviewVersionKey(orgId), ANALYTICS_PREVIEW_FRESHNESS_MS)
}
