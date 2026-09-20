/**
 * HR-15 home announcement validation (pure, no I/O): every refusal
 * names the remedy, and the setup write path surfaces the message intact.
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

export const AUDIENCES: readonly AnnouncementAudience[] = ['all', 'managers', 'employees']

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

