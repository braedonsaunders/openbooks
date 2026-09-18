import 'server-only'

import { eq, sql } from 'drizzle-orm'
import { db, withBypass, withBypassContext } from '@openbooks/engine/src/db.ts'
import { sealSecret, unsealSecret } from '@openbooks/engine/src/secrets.ts'
import { PLATFORM_SETTINGS_ID, platformSettings } from '@openbooks/schema'

/**
 * Where in-app issue reports go.
 *
 * This is INSTALLATION configuration, not tenant configuration: one product
 * tracker for the whole deployment, chosen by the operator who runs it. It
 * lives on the org-less `platform_settings` singleton (migration 0173) behind
 * bypass-only RLS, so an org administrator cannot point the operator's issue
 * tracker somewhere else — which is why it is deliberately absent from
 * Company Settings and from the Features switchboard.
 *
 * The access token is AES-256-GCM sealed by engine/src/secrets.ts under
 * OPENBOOKS_DATA_KEY, the same wire format as every other stored credential.
 * Nothing on this module's read paths returns the plaintext to a browser: the
 * settings view carries only whether a token exists.
 */

// GitHub's own limits, enforced here so a typo cannot become a request to an
// arbitrary path under api.github.com.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

const MAX_LABELS = 8
const MAX_LABEL_CHARS = 40

type StoredFeedback = {
  enabled?: boolean
  owner?: string
  repo?: string
  labels?: string[]
  searchDuplicates?: boolean
  /** enc:v1 sealed access token (engine/src/secrets.ts). Never plaintext. */
  token?: string
}

/** What the operator console may see — existence of a token, never its value. */
export type FeedbackSettingsView = {
  enabled: boolean
  owner: string
  repo: string
  labels: string
  searchDuplicates: boolean
  hasToken: boolean
  /** Enabled AND completely configured — the state the launcher renders in. */
  ready: boolean
}

export type FeedbackSettingsInput = {
  enabled: boolean
  owner: string
  repo: string
  labels: string
  searchDuplicates: boolean
  /** New plaintext token to seal, or undefined to keep the stored one. */
  token?: string
}

/** The decrypted destination a turn actually files against. */
export type FeedbackRuntime = {
  owner: string
  repo: string
  token: string
  labels: string[]
  searchDuplicates: boolean
}

/** Comma-separated operator input → a bounded, de-duplicated label list. */
export function parseFeedbackLabels(value: string): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const part of value.split(',')) {
    const label = part.trim()
    if (!label || label.length > MAX_LABEL_CHARS || seen.has(label.toLowerCase())) continue
    seen.add(label.toLowerCase())
    labels.push(label)
    if (labels.length >= MAX_LABELS) break
  }
  return labels
}

/** Validate and normalize an operator save. Throws with an operator-readable reason. */
export function sanitizeFeedbackSettingsInput(input: FeedbackSettingsInput): FeedbackSettingsInput {
  const owner = input.owner.trim()
  const repo = input.repo.trim()
  if (owner && !OWNER_RE.test(owner)) throw new Error('A valid repository owner is required.')
  if (repo && (!REPO_RE.test(repo) || repo === '.' || repo === '..')) {
    throw new Error('A valid repository name is required.')
  }
  if (input.enabled && (!owner || !repo)) {
    throw new Error('Reporting needs a repository owner and name before it can be enabled.')
  }
  return {
    enabled: input.enabled,
    owner,
    repo,
    labels: parseFeedbackLabels(input.labels).join(', '),
    searchDuplicates: input.searchDuplicates,
    token: input.token?.trim() || undefined,
  }
}

async function readStored(): Promise<StoredFeedback> {
  const rows = await withBypassContext(() =>
    db
      .select({ settings: platformSettings.settings })
      .from(platformSettings)
      .where(eq(platformSettings.id, PLATFORM_SETTINGS_ID))
      .limit(1),
  )
  const settings = rows[0]?.settings
  if (!settings || typeof settings !== 'object') return {}
  const feedback = (settings as Record<string, unknown>).feedback
  return feedback && typeof feedback === 'object' ? (feedback as StoredFeedback) : {}
}

function toView(raw: StoredFeedback): FeedbackSettingsView {
  const owner = typeof raw.owner === 'string' ? raw.owner : ''
  const repo = typeof raw.repo === 'string' ? raw.repo : ''
  const hasToken = typeof raw.token === 'string' && raw.token.length > 0
  const enabled = raw.enabled === true
  return {
    enabled,
    owner,
    repo,
    labels: Array.isArray(raw.labels) ? raw.labels.join(', ') : '',
    searchDuplicates: raw.searchDuplicates !== false,
    hasToken,
    ready: enabled && hasToken && Boolean(owner && repo),
  }
}

export async function getFeedbackSettings(): Promise<FeedbackSettingsView> {
  return toView(await readStored())
}

/**
 * Whether the header control should render at all. A deliberately cheap,
 * secret-free read: the app shell runs it on every page.
 */
export async function isFeedbackReady(): Promise<boolean> {
  return (await getFeedbackSettings()).ready
}

/** The decrypted token, for verifying a destination the operator just saved. */
export async function getFeedbackToken(): Promise<string | null> {
  const raw = await readStored()
  return raw.token ? unsealSecret(raw.token) : null
}

/** The decrypted destination, or null when reporting is off or incomplete. */
export async function getFeedbackRuntime(): Promise<FeedbackRuntime | null> {
  const raw = await readStored()
  if (raw.enabled !== true || !raw.token) return null
  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : ''
  const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
  if (!OWNER_RE.test(owner)) return null
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') return null
  const token = unsealSecret(raw.token)
  if (!token) return null
  return {
    owner,
    repo,
    token,
    labels: Array.isArray(raw.labels) ? raw.labels.filter((l) => typeof l === 'string') : [],
    searchDuplicates: raw.searchDuplicates !== false,
  }
}

/**
 * Persist a save. The read/merge/write runs inside ONE transaction under the
 * row lock, so two operators saving at once cannot interleave into a config
 * that is half of each — and an omitted token keeps the sealed one rather
 * than silently clearing the destination's credential.
 */
export async function saveFeedbackSettings(
  input: FeedbackSettingsInput,
  actorId: string,
): Promise<FeedbackSettingsView> {
  const validated = sanitizeFeedbackSettingsInput(input)
  return withBypass(async () => {
    const settings = await lockSettings()
    const previous = (settings.feedback ?? {}) as StoredFeedback
    const next: StoredFeedback = {
      enabled: validated.enabled,
      owner: validated.owner || undefined,
      repo: validated.repo || undefined,
      labels: parseFeedbackLabels(validated.labels),
      searchDuplicates: validated.searchDuplicates,
      token: validated.token ? sealSecret(validated.token) : previous.token,
    }
    await writeSettings({ ...settings, feedback: next }, actorId)
    return toView(next)
  })
}

/** Forget the stored credential without losing the rest of the destination. */
export async function clearFeedbackToken(actorId: string): Promise<void> {
  await withBypass(async () => {
    const settings = await lockSettings()
    const previous = (settings.feedback ?? {}) as StoredFeedback
    // A destination with no credential cannot file, so the switch goes off
    // with the token rather than leaving a header control that always fails.
    const next: StoredFeedback = { ...previous, token: undefined, enabled: false }
    await writeSettings({ ...settings, feedback: next }, actorId)
  })
}

/** Read the singleton under its row lock. Callers are already inside withBypass. */
async function lockSettings(): Promise<Record<string, unknown>> {
  const rows = await db.execute<{ settings: Record<string, unknown> | null }>(sql`
    select settings from platform_settings where id = ${PLATFORM_SETTINGS_ID} for update`)
  return rows.rows[0]?.settings ?? {}
}

async function writeSettings(settings: Record<string, unknown>, actorId: string): Promise<void> {
  // Upsert rather than update: 0173 seeds the row, but an installation
  // restored from an older archive should not lose its first save to a
  // missing row.
  await db.execute(sql`
    insert into platform_settings (id, settings, created_by, updated_by)
    values (${PLATFORM_SETTINGS_ID}, ${JSON.stringify(settings)}::jsonb, ${actorId}, ${actorId})
    on conflict (id) do update
       set settings = excluded.settings, updated_at = now(), updated_by = excluded.updated_by`)
}

/**
 * Text the reporter must never send to the tracker verbatim.
 *
 * The package redacts structural PII (emails, phone numbers, ids, query
 * strings) on its own; this adds the values only the host knows — who is
 * reporting and which company they work for. Short values are skipped: a
 * two-character company name would blank half the report.
 */
export function feedbackDenyList(
  values: ReadonlyArray<string | null | undefined>,
): string[] {
  return values.flatMap((value) => {
    const text = value?.trim()
    return text && text.length >= 3 ? [text] : []
  })
}
