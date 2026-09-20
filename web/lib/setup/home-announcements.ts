import 'server-only'

import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
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

export type AnnouncementAudience = 'all' | 'managers' | 'employees'

export interface HomeAnnouncement {
  id: string
  title: string
  body: string | null
  audience: AnnouncementAudience
  startsOn: string
  endsOn: string | null
}

const AUDIENCES: readonly AnnouncementAudience[] = ['all', 'managers', 'employees']

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())
}

export function validateAnnouncement(input: {
  title?: unknown
  body?: unknown
  audience?: unknown
  startsOn?: unknown
  endsOn?: unknown
}): { title: string; body: string | null; audience: AnnouncementAudience; startsOn: string; endsOn: string | null } {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) throw new Error('an announcement needs a title — say what it is in one line')
  if (title.length > 200) throw new Error('the title must fit in 200 characters')
  const body = input.body === null || input.body === undefined ? null : String(input.body).trim() || null
  if (body !== null && body.length > 2000) throw new Error('the body must fit in 2000 characters')
  if (input.audience !== undefined && !(AUDIENCES as readonly unknown[]).includes(input.audience)) {
    throw new Error('audience is one of all, managers, or employees — pick who should see it')
  }
  if (!validDate(input.startsOn)) throw new Error('startsOn is a calendar date — say when the announcement goes live')
  const endsOn = input.endsOn === null || input.endsOn === undefined || input.endsOn === '' ? null : input.endsOn
  if (endsOn !== null && !validDate(endsOn)) throw new Error('endsOn is a calendar date or empty — say when it comes down')
  if (endsOn !== null && endsOn < (input.startsOn as string)) {
    throw new Error('endsOn precedes startsOn — the announcement cannot come down before it goes live')
  }
  return { title, body, audience: (input.audience as AnnouncementAudience | undefined) ?? 'all', startsOn: input.startsOn as string, endsOn }
}

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

export async function createHomeAnnouncementRow(
  orgId: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const valid = validateAnnouncement(body)
  const id = randomUUID()
  await db.transaction(async (tx) => {
    const list = await readList(tx, orgId)
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
  const valid = validateAnnouncement(body)
  await db.transaction(async (tx) => {
    const list = await readList(tx, orgId)
    const index = list.findIndex((row) => row.id === id)
    if (index < 0) throw Object.assign(new Error('announcement not found'), { status: 404 })
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
