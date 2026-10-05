import 'server-only'
import { createHash } from 'node:crypto'
import { getLocale, getTranslations } from 'next-intl/server'
import { readSharedCache, claimSharedCache, publishSharedCache, releaseSharedCache } from '@openbooks/jobs/read-cache'
import { ANALYTICS_PREVIEW_FRESHNESS_MS as FRESHNESS_MS, analyticsPreviewVersionKey as versionKey, analyticsLocalPreviewVersion } from './preview-invalidation'
export { invalidateAnalyticsPreviews } from './preview-invalidation'
import type { Authz } from '../authz'
import type { AnalyticsPreview } from './dashboard-catalog'
import { currentAnalyticsRead, observeAnalyticsSource } from './read-context'

const MAX_ENTRIES = 256
const MAX_BUILDERS = 4
const MAX_VALUE_BYTES = 2 * 1024 * 1024
const MAX_CACHE_BYTES = 16 * 1024 * 1024
type CachedValue = { version: 2; observedAt: string; data: unknown }
const values = new Map<string, { until: number; bytes: number; value: CachedValue }>()
const pending = new Map<string, Promise<CachedValue>>()
const revisions = new Map<string, Promise<string | null | undefined>>()
let cacheBytes = 0
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
  const basis = JSON.stringify({ version: 2, orgId: authz.user.orgId, scope: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds].sort(), permissions: [...authz.permissions].sort(), slug, filters, locale, revision })
  return `openbooks:analytics:preview:${createHash('sha256').update(basis).digest('hex')}`
}

function forget(key: string) {
  const previous = values.get(key)
  if (previous) cacheBytes -= previous.bytes
  values.delete(key)
}

function remember(key: string, value: CachedValue, bytes: number) {
  forget(key)
  if (bytes > MAX_VALUE_BYTES) return
  while (values.size >= MAX_ENTRIES || cacheBytes + bytes > MAX_CACHE_BYTES) forget(values.keys().next().value!)
  values.set(key, { value, bytes, until: Date.parse(value.observedAt) + FRESHNESS_MS })
  cacheBytes += bytes
}

function decoded(raw: string | null | undefined): CachedValue | null {
  if (!raw) return null
  if (Buffer.byteLength(raw) > MAX_VALUE_BYTES) return null
  try {
    const value = JSON.parse(raw) as CachedValue
    if (value.version !== 2 || !('data' in value) || typeof value.observedAt !== 'string') return null
    const age = Date.now() - Date.parse(value.observedAt)
    if (!Number.isFinite(age) || age < 0 || age >= FRESHNESS_MS) return null
    return value
  } catch { return null }
}

async function build<T>(load: () => Promise<T>): Promise<T> {
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

export async function analyticsCacheIdentity(orgId: string): Promise<{ locale: string; revision: string }> {
  let revisionRead = revisions.get(orgId)
  if (!revisionRead) {
    revisionRead = readSharedCache(versionKey(orgId))
    revisions.set(orgId, revisionRead)
    const selected = revisionRead
    void revisionRead.finally(() => { if (revisions.get(orgId) === selected) revisions.delete(orgId) })
  }
  const [locale, sharedVersion] = await Promise.all([getLocale(), revisionRead])
  const revision = sharedVersion === undefined ? `local:${analyticsLocalPreviewVersion(orgId)}` : `shared:${sharedVersion ?? '0'}`
  return { locale, revision }
}

/** One bounded cache for projections and their shared source aggregates. The
 * caller's authority is part of every key; user identity is not, so equally
 * authorized operators share work without widening a legal-entity fence. */
export async function cachedAnalyticsRead<T>(authz: Authz, slug: string, query: Record<string, string | undefined>, load: () => Promise<T>, options: { admit?: boolean; identity?: { locale: string; revision: string } } = {}): Promise<T> {
  const { locale, revision } = options.identity ?? await analyticsCacheIdentity(authz.user.orgId)
  const key = analyticsPreviewKey(authz, slug, query, locale, revision)
  const hit = values.get(key)
  if (hit && hit.until > Date.now() && Date.parse(hit.value.observedAt) <= Date.now()) {
    observeAnalyticsSource(hit.value.observedAt)
    return structuredClone(hit.value.data) as T
  }
  if (hit) forget(key)
  const running = pending.get(key)
  if (running) {
    const result = await running
    observeAnalyticsSource(result.observedAt)
    return structuredClone(result.data) as T
  }
  if (pending.size >= 256) throw new AnalyticsPreviewBusyError()
  const action = (async () => {
    const shared = decoded(await readSharedCache(key))
    if (shared) { observeAnalyticsSource(shared.observedAt); remember(key, shared, Buffer.byteLength(JSON.stringify(shared))); return shared }
    let token = await claimSharedCache(key)
    if (token === null) {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        const raw = await readSharedCache(key)
        const ready = decoded(raw)
        if (ready) { observeAnalyticsSource(ready.observedAt); remember(key, ready, Buffer.byteLength(raw!)); return ready }
        if (raw === undefined) { token = undefined; break }
        token = await claimSharedCache(key)
        if (token !== null) break
      }
      if (token === null) throw await busyRefusal()
    }
    try {
      const value = options.admit === false ? await load() : await build(load)
      const observedAt = new Date(currentAnalyticsRead()?.observedAt ?? Date.now()).toISOString()
      const envelope: CachedValue = { version: 2, observedAt, data: value }
      const encoded = JSON.stringify(envelope)
      const bytes = Buffer.byteLength(encoded)
      remember(key, envelope, bytes)
      const lifetime = Date.parse(observedAt) + FRESHNESS_MS - Date.now()
      if (token && bytes <= MAX_VALUE_BYTES && lifetime > 0) await publishSharedCache(key, token, encoded, lifetime)
      return envelope
    } finally { if (token) await releaseSharedCache(key, token) }
  })()
  pending.set(key, action)
  try {
    const result = await action
    observeAnalyticsSource(result.observedAt)
    return structuredClone(result.data) as T
  }
  finally { if (pending.get(key) === action) pending.delete(key) }
}

export function cachedAnalyticsPreview(authz: Authz, slug: string, query: Record<string, string | undefined>, load: () => Promise<AnalyticsPreview>): Promise<AnalyticsPreview> {
  const read = currentAnalyticsRead()
  return cachedAnalyticsRead(authz, `preview:${slug}`, query, load, { identity: read })
}
