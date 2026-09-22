import 'server-only'

import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@openbooks/engine/src/platform/canonical-json.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'

/**
 * HR-15 home announcements: an admin-authored list with audience scope and
 * dates, stored in org settings (orgs.settings.home.announcements) — not a
 * new table. Served through the Setup registry entity `home-announcements`
 * (table 'orgs', dataSource 'home-announcements'), so authoring rides the
 * shared setup drawer, validation, audit, and feature fence.
 *
 * Concurrency: every mutation takes the org's advisory lock and
 * read-modify-writes inside one transaction — one writer wins, the loser
 * retries against the fresh list rather than clobbering it.
 */

import { AUDIENCES, validateAnnouncement, type AnnouncementAudience, type HomeAnnouncement } from './home-announcements-validate'

function coerceList(value: unknown): HomeAnnouncement[] {
  if (!Array.isArray(value)) return []
  const out: HomeAnnouncement[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.title !== 'string') continue
    out.push({
      id: row.id,
      title: row.title,
      body: typeof row.body === 'string' ? row.body : null,
      audience: (AUDIENCES as readonly unknown[]).includes(row.audience) ? (row.audience as AnnouncementAudience) : 'all',
      startsOn: typeof row.startsOn === 'string' ? row.startsOn : '',
      endsOn: typeof row.endsOn === 'string' ? row.endsOn : null,
    })
  }
  return out
}

async function readList(exec: Pick<typeof db, 'execute'>, orgId: string): Promise<HomeAnnouncement[]> {
  const rows = (await exec.execute<{ settings: unknown }>(sql`
    select settings from orgs where id = ${orgId}
  `)).rows
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>
  const home = (settings.home ?? {}) as Record<string, unknown>
  return coerceList(home.announcements)
}

export async function loadHomeAnnouncementRows(orgId: string): Promise<Record<string, unknown>[]> {
  // Records cross as plain JSON for the generic setup table; the typed
  // shape stays inside this module (liveHomeAnnouncements below).
  const rows = await readList(db, orgId)
  return rows
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn) || a.title.localeCompare(b.title))
    .map((row) => ({ ...row })) as unknown as Record<string, unknown>[]
}

/** Live announcements for an audience on a date — what the home card renders. */
export async function liveHomeAnnouncements(
  orgId: string,
  audience: 'manager' | 'employee' | 'admin',
  today: string,
): Promise<HomeAnnouncement[]> {
  const day = today.slice(0, 10)
  return (await readList(db, orgId))
    .filter((row) => row.startsOn <= day && (row.endsOn === null || row.endsOn === '' || day <= row.endsOn))
    .filter((row) =>
      row.audience === 'all' ||
      (row.audience === 'managers' && (audience === 'manager' || audience === 'admin')) ||
      (row.audience === 'employees' && (audience === 'employee' || audience === 'admin')),
    )
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn) || a.title.localeCompare(b.title))
    .slice(0, 5)
}

async function writeList(
  exec: Pick<typeof db, 'execute'>,
  orgId: string,
  list: HomeAnnouncement[],
): Promise<void> {
  await exec.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'home-announcements:' + orgId}, 0))`)
  const current = (await exec.execute<{ settings: unknown }>(sql`
    select settings from orgs where id = ${orgId} for update
  `)).rows[0]?.settings as Record<string, unknown> | null
  if (!current) throw new Error('organization not found')
  const home = { ...((current.home ?? {}) as Record<string, unknown>), announcements: list }
  await exec.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{home}', ${JSON.stringify(home)}::jsonb, true)
     where id = ${orgId}
  `)
}

/**
 * Create one announcement. With `options.id` (the POST route's
 * Idempotency-Key) the create is idempotent: the key becomes the
 * announcement id, so an exact retry returns the existing row with no second
 * write, while a changed payload under the same key is refused as a 409
 * conflict. Announcements live in org settings JSON rather than a table, so
 * there is no insert audit to carry the request image — the stored
 * announcement itself is the immutable image the retry is compared against.
 */
export async function createHomeAnnouncementRow(
  orgId: string,
  body: Record<string, unknown>,
  options: { id?: string } = {},
): Promise<{ id: string }> {
  const valid = validateAnnouncement(body)
  const id = options.id ?? randomUUID()
  await db.transaction(async (tx) => {
    // Take the writer lock BEFORE reading: the read-modify-write must be
    // atomic, otherwise a concurrent writer's entry is silently clobbered.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'home-announcements:' + orgId}, 0))`)
    const list = await readList(tx, orgId)
    const existing = options.id === undefined ? undefined : list.find((row) => row.id === id)
    if (existing) {
      if (canonicalJson(existing) === canonicalJson({ id, ...valid })) return
      throw Object.assign(
        new Error('This announcement was already saved with different details. Close and reopen the drawer to try again with a fresh request.'),
        { status: 409, code: 'idempotency-conflict' },
      )
    }
    list.push({ id, ...valid })
    await writeList(tx, orgId, list)
  })
  return { id }
}

export async function saveHomeAnnouncementRow(
  orgId: string,
  id: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  await db.transaction(async (tx) => {
    const list = await readList(tx, orgId)
    const index = list.findIndex((row) => row.id === id)
    if (index < 0) throw Object.assign(new Error('announcement not found'), { status: 404 })
    // PATCH semantics like the setup drawer: the body overlays the stored
    // row, so a drawer round-trip that omits unchanged fields still validates.
    const valid = validateAnnouncement({ ...list[index], ...body })
    list[index] = { id, ...valid }
    await writeList(tx, orgId, list)
  })
  return { id }
}

export async function deleteHomeAnnouncementRow(orgId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const list = await readList(tx, orgId)
    if (!list.some((row) => row.id === id)) throw Object.assign(new Error('announcement not found'), { status: 404 })
    await writeList(tx, orgId, list.filter((row) => row.id !== id))
  })
}
