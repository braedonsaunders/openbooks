import 'server-only'
import { createHash } from 'node:crypto'
import { getLocale, getTranslations } from 'next-intl/server'
import { readSharedCache, claimSharedCache, publishSharedCache, releaseSharedCache } from '@openbooks/jobs/read-cache'
import { ANALYTICS_PREVIEW_FRESHNESS_MS as FRESHNESS_MS, analyticsPreviewVersionKey as versionKey, analyticsLocalPreviewVersion } from './preview-invalidation'
export { invalidateAnalyticsPreviews } from './preview-invalidation'
import type { Authz } from '../authz'
import type { AnalyticsPreview } from './dashboard-catalog'

const MAX_ENTRIES = 256
const MAX_BUILDERS = 4
const values = new Map<string, { until: number; value: AnalyticsPreview }>()
const pending = new Map<string, Promise<AnalyticsPreview>>()
let builders = 0
const waiting: (() => void)[] = []

export class AnalyticsPreviewBusyError extends Error {
  readonly status = 429
  constructor(message: string) {
    super(message)
    this.name = 'AnalyticsPreviewBusyError'
  }
}

/**
 * The busy refusal is catalogued, never a hardcoded English string: the hub
 * renders it beside its Retry control, which is the named remedy.
 */
async function busyRefusal(): Promise<AnalyticsPreviewBusyError> {
  return new AnalyticsPreviewBusyError((await getTranslations('analytics'))('preview.busy'))
}

export function analyticsPreviewKey(authz: Authz, slug: string, query: Record<string, string | undefined>, locale: string, revision: string): string {
  const filters = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right)))
  const basis = JSON.stringify({ version: 1, orgId: authz.user.orgId, scope: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds].sort(), permissions: [...authz.permissions].sort(), slug, filters, locale, revision })
  return `openbooks:analytics:preview:${createHash('sha256').update(basis).digest('hex')}`
}

function remember(key: string, value: AnalyticsPreview) {
  if (values.size >= MAX_ENTRIES && !values.has(key)) values.delete(values.keys().next().value!)
  values.set(key, { value, until: Date.now() + FRESHNESS_MS })
}

function decoded(raw: string | null | undefined): AnalyticsPreview | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as AnalyticsPreview
    if (!Array.isArray(value.metrics) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt))) return null
    if (Date.now() - Date.parse(value.observedAt) >= FRESHNESS_MS) return null
    return value
  } catch { return null }
}

async function build(load: () => Promise<AnalyticsPreview>): Promise<AnalyticsPreview> {
  if (builders >= MAX_BUILDERS) {
    if (waiting.length >= 128) throw await busyRefusal()
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else builders += 1
  try { return await load() }
  finally {
    const next = waiting.shift()
    if (next) next()
    else builders -= 1
  }
}

export async function cachedAnalyticsPreview(authz: Authz, slug: string, query: Record<string, string | undefined>, load: () => Promise<AnalyticsPreview>): Promise<AnalyticsPreview> {
  const [locale, sharedVersion] = await Promise.all([getLocale(), readSharedCache(versionKey(authz.user.orgId))])
  const revision = sharedVersion === undefined ? `local:${analyticsLocalPreviewVersion(authz.user.orgId)}` : `shared:${sharedVersion ?? '0'}`
  const key = analyticsPreviewKey(authz, slug, query, locale, revision)
  const hit = values.get(key)
  if (hit && hit.until > Date.now() && Date.now() - Date.parse(hit.value.observedAt) < FRESHNESS_MS) return hit.value
  const running = pending.get(key)
  if (running) return running
  const action = (async () => {
    const shared = decoded(await readSharedCache(key))
    if (shared) { remember(key, shared); return shared }
    let token = await claimSharedCache(key)
    if (token === null) {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const raw = await readSharedCache(key)
        const ready = decoded(raw)
        if (ready) { remember(key, ready); return ready }
        if (raw === undefined) { token = undefined; break }
        token = await claimSharedCache(key)
        if (token !== null) break
      }
      if (token === null) throw await busyRefusal()
    }
    try {
      const value = await build(load)
      remember(key, value)
      if (token) await publishSharedCache(key, token, JSON.stringify(value), FRESHNESS_MS)
      return value
    } finally { if (token) await releaseSharedCache(key, token) }
  })()
  pending.set(key, action)
  try { return await action }
  finally { if (pending.get(key) === action) pending.delete(key) }
}
