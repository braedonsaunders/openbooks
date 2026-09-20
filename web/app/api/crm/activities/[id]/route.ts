import { crmActivityScope, crmSubjectVisible } from '../../../../../lib/crm-scope'
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { loadActivity } from '../../../../../lib/crm'
import { isIsoTimestamp } from '../../../../../lib/crm-dates'

export const runtime = 'nodejs'

const KINDS = ['task', 'call', 'event', 'email', 'note']
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

type QueryExecutor = Pick<typeof db, 'execute'>

// The stored timestamptz arrives as text (or a Date); normalize either shape
// to the literal the UPDATE will cast.
function storedTimestampText(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value !== 'string' || !value.trim()) return null
  return value.trim()
}

// True when the effective pair would trip crm_activity_dates. Compared by
// Postgres so naive request strings cast in the transaction TimeZone, exactly
// as the UPDATE casts them; a JS Date comparison would use the Node zone and
// disagree with the CHECK after a store/load round-trip.
async function endsPrecedeStarts(executor: QueryExecutor, startsAt: string | null, endsAt: string | null): Promise<boolean> {
  if (!startsAt || !endsAt) return false
  const result = await executor.execute(sql`select 1 where ${endsAt}::timestamptz < ${startsAt}::timestamptz`)
  return result.rows.length === 1
}

async function subjectExists(orgId: string, kind: string, id: string, allowed?: ReadonlySet<string> | null): Promise<boolean> {
  if (!isUuid(id)) return false
  const result=await db.execute(sql`select 1 where ${crmSubjectVisible(sql`${orgId}`,sql`${kind}`,sql`${id}`,allowed)}`)
  return result.rows.length===1
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.activities.read', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const activity = isUuid(id) ? await loadActivity(id, gate.user.orgId, gate.allowedSubsidiaryIds) : null
  return activity ? NextResponse.json(activity) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.activities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const current = (await db.execute(sql`select a.* from crm_activities a where a.id = ${id} and a.org_id = ${user.orgId}${crmActivityScope(gate.allowedSubsidiaryIds)}`))
  if (!current.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data)
  if (body.kind !== undefined && (typeof body.kind !== 'string' || !KINDS.includes(body.kind))) return NextResponse.json({ error: 'invalid activity kind' }, { status: 422 })
  if (body.status !== undefined && (typeof body.status !== 'string' || !STATUSES.includes(body.status))) return NextResponse.json({ error: 'invalid activity status' }, { status: 422 })
  if (body.priority !== undefined && (typeof body.priority !== 'string' || !PRIORITIES.includes(body.priority))) return NextResponse.json({ error: 'invalid priority' }, { status: 422 })
  if (body.subject !== undefined && !textOrNull(body.subject)) return NextResponse.json({ error: 'subject is required' }, { status: 422 })
  if (body.isPrivate !== undefined && typeof body.isPrivate !== 'boolean') return NextResponse.json({ error: 'isPrivate must be a boolean' }, { status: 422 })
  for (const key of ['ownerUserId', 'assignedUserId'] as const) {
    const value = body[key]
    if (value !== undefined && value !== null && (typeof value !== 'string' || !isUuid(value) || !((await db.execute(sql`select 1 from users where id = ${value} and org_id = ${user.orgId}`))).rows[0])) {
      return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    }
  }
  // Timestamp columns: refuse anything Postgres would not cast so a 22P02
  // never escapes the write as a 500. Blank/null clears the value.
  for (const key of ['startsAt', 'endsAt', 'dueAt', 'reminderAt'] as const) {
    const value = body[key]
    if (value != null && value !== '' && !isIsoTimestamp(value)) {
      return NextResponse.json({ error: `invalid ${key}: expected an ISO date or date-time` }, { status: 422 })
    }
  }
  // The effective pair (request value, else the stored row) is refused here
  // instead of tripping crm_activity_dates inside the transaction. Re-checked
  // under the row lock below, where the stored side cannot have gone stale.
  const startsAt = body.startsAt !== undefined ? textOrNull(body.startsAt) : storedTimestampText(current.rows[0].starts_at)
  const endsAt = body.endsAt !== undefined ? textOrNull(body.endsAt) : storedTimestampText(current.rows[0].ends_at)
  if (await endsPrecedeStarts(db, startsAt, endsAt)) return NextResponse.json({ error: 'end must not precede start' }, { status: 422 })
  const duration = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === '' ? null : Number(body.durationMinutes)
  // duration_minutes is integer: a value the column cannot hold would die in
  // Postgres as a raw failure (HTTP 500 with the full UPDATE — this verb has
  // no catch), so refuse it here with a named 422 and nothing written.
  if (duration !== null && (!Number.isInteger(duration) || duration < 0 || duration > 2147483647)) return NextResponse.json({ error: 'duration must be non-negative whole minutes the activity can store' }, { status: 422 })
  const links = body.links as Array<{ subjectKind: string; subjectId: string }> | undefined
  if (links) {
    if (!Array.isArray(links)) return NextResponse.json({ error: 'links must be an array' }, { status: 422 })
    for (const link of links) if (!link || typeof link !== 'object' || !await subjectExists(user.orgId, link.subjectKind, link.subjectId, gate.allowedSubsidiaryIds)) return NextResponse.json({ error: 'invalid related record' }, { status: 422 })
  }
  const participants = body.participants as Array<{ userId?: string; contactId?: string; email?: string; response?: string }> | undefined
  if (participants && !Array.isArray(participants)) return NextResponse.json({ error: 'participants must be an array' }, { status: 422 })
  if (participants) for (const participant of participants) {
    if (!participant || typeof participant !== 'object') return NextResponse.json({ error: 'invalid participant' }, { status: 422 })
    const targets = [participant.userId, participant.contactId, textOrNull(participant.email)].filter(Boolean)
    if (targets.length !== 1) return NextResponse.json({ error: 'each participant must have exactly one target' }, { status: 422 })
    if (participant.userId && (!isUuid(participant.userId) || !((await db.execute(sql`select 1 from users where id = ${participant.userId} and org_id = ${user.orgId}`))).rows[0])) return NextResponse.json({ error: 'invalid participant user' }, { status: 422 })
    if (participant.contactId && (!isUuid(participant.contactId) || !((await db.execute(sql`select 1 where ${crmSubjectVisible(sql`${user.orgId}`,sql`'contact'`,sql`${participant.contactId}`,gate.allowedSubsidiaryIds)}`))).rows[0])) return NextResponse.json({ error: 'invalid participant contact' }, { status: 422 })
  }

    const denied = await db.transaction(async (tx) => {
    const visible=await tx.execute(sql`select a.* from crm_activities a where a.id=${id} and a.org_id=${user.orgId}${crmActivityScope(gate.allowedSubsidiaryIds)} for update of a`)
    if (!visible.rows.length) return NextResponse.json({error:'not found'},{status:404})
    // The stored side of the pair comes from the locked row: a concurrent
    // save between the preflight read and this lock must not restore stale
    // dates or stale audit evidence.
    const lockedStartsAt = body.startsAt !== undefined ? textOrNull(body.startsAt) : storedTimestampText(visible.rows[0]?.starts_at)
    const lockedEndsAt = body.endsAt !== undefined ? textOrNull(body.endsAt) : storedTimestampText(visible.rows[0]?.ends_at)
    if (await endsPrecedeStarts(tx as unknown as QueryExecutor, lockedStartsAt, lockedEndsAt)) return NextResponse.json({error:'end must not precede start'},{status:422})
    if (links) for (const link of links) {
      const valid=await tx.execute(sql`select 1 where ${crmSubjectVisible(sql`${user.orgId}`,sql`${link.subjectKind}`,sql`${link.subjectId}`,gate.allowedSubsidiaryIds)}`)
      if (!valid.rows.length) return NextResponse.json({error:'invalid related record'},{status:422})
    }
    // Child evidence is captured on both sides of the delete/insert pairs so
    // the audit row records what actually changed, not just what was asked.
    const linksBefore = links ? (await tx.execute(sql`select subject_kind, subject_id from crm_activity_links where activity_id = ${id} and org_id = ${user.orgId} order by subject_kind, subject_id`)).rows : null
    const participantsBefore = participants ? (await tx.execute(sql`select user_id, contact_id, email, response from crm_activity_participants where activity_id = ${id} and org_id = ${user.orgId} order by user_id, contact_id, email, response`)).rows : null
    await tx.execute(sql`
      update crm_activities set
        kind = ${body.kind ?? sql`kind`}, status = ${body.status ?? sql`status`},
        subject = ${body.subject !== undefined ? textOrNull(body.subject) : sql`subject`},
        body = ${body.body !== undefined ? textOrNull(body.body) : sql`body`},
        priority = ${body.priority ?? sql`priority`},
        owner_user_id = ${body.ownerUserId !== undefined ? body.ownerUserId : sql`owner_user_id`},
        assigned_user_id = ${body.assignedUserId !== undefined ? body.assignedUserId : sql`assigned_user_id`},
        starts_at = ${body.startsAt !== undefined ? textOrNull(body.startsAt) : sql`starts_at`},
        ends_at = ${body.endsAt !== undefined ? textOrNull(body.endsAt) : sql`ends_at`},
        due_at = ${body.dueAt !== undefined ? textOrNull(body.dueAt) : sql`due_at`},
        reminder_at = ${body.reminderAt !== undefined ? textOrNull(body.reminderAt) : sql`reminder_at`},
        duration_minutes = ${body.durationMinutes !== undefined ? duration : sql`duration_minutes`},
        is_private = ${body.isPrivate !== undefined ? body.isPrivate === true : sql`is_private`},
        completed_at = case
          when ${body.status ?? null} = 'completed' and completed_at is null then now()
          when ${body.status ?? null} <> 'completed' then null else completed_at end,
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}`)
    if (links) {
      await tx.execute(sql`delete from crm_activity_links where activity_id = ${id} and org_id = ${user.orgId}`)
      for (const link of links) await tx.execute(sql`
        insert into crm_activity_links (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
        values (${user.orgId}, ${id}, ${link.subjectKind}, ${link.subjectId}, ${user.id}, ${user.id})`)
    }
    if (participants) {
      await tx.execute(sql`delete from crm_activity_participants where activity_id = ${id} and org_id = ${user.orgId}`)
      for (const participant of participants) {
        await tx.execute(sql`
          insert into crm_activity_participants
            (org_id, activity_id, user_id, contact_id, email, response, created_by, updated_by)
          values (${user.orgId}, ${id}, ${participant.userId ?? null}, ${participant.contactId ?? null},
                  ${textOrNull(participant.email)}, ${participant.response ?? 'none'}, ${user.id}, ${user.id})`)
      }
    }
    await tx.execute(sql`
      update crm_account_profiles cp set last_activity_at = greatest(coalesce(cp.last_activity_at, '-infinity'), now()), updated_at = now()
       where cp.org_id = ${user.orgId} and cp.party_id in (select subject_id from crm_activity_links where activity_id = ${id} and org_id = ${user.orgId} and subject_kind = 'account')`)
    const afterRow = (await tx.execute(sql`select a.* from crm_activities a where a.id = ${id} and a.org_id = ${user.orgId}`)).rows[0]
    const linksAfter = links ? (await tx.execute(sql`select subject_kind, subject_id from crm_activity_links where activity_id = ${id} and org_id = ${user.orgId} order by subject_kind, subject_id`)).rows : null
    const participantsAfter = participants ? (await tx.execute(sql`select user_id, contact_id, email, response from crm_activity_participants where activity_id = ${id} and org_id = ${user.orgId} order by user_id, contact_id, email, response`)).rows : null
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'crm_activities', ${id}, 'update', ${JSON.stringify({
        before: visible.rows[0],
        after: afterRow,
        requested: body,
        links: links ? { before: linksBefore, after: linksAfter } : undefined,
        participants: participants ? { before: participantsBefore, after: participantsAfter } : undefined,
      })}::jsonb, ${user.id})`)
  })
  if (denied) return denied
  return NextResponse.json(await loadActivity(id, user.orgId, gate.allowedSubsidiaryIds))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.activities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const deleted = await db.transaction(async (tx) => {
    const visible=await tx.execute(sql`select a.* from crm_activities a where a.id=${id} and a.org_id=${gate.user.orgId}${crmActivityScope(gate.allowedSubsidiaryIds)} for update of a`)
    if (!visible.rows.length) return {rows:[]}
    const before = visible.rows[0]
    // Both child sets are snapshotted under the same lock before the deletes
    // so the audit row preserves the full erased evidence with after null.
    const linksBefore = (await tx.execute(sql`select subject_kind, subject_id from crm_activity_links where activity_id = ${id} and org_id = ${gate.user.orgId} order by subject_kind, subject_id`)).rows
    const participantsBefore = (await tx.execute(sql`select user_id, contact_id, email, response from crm_activity_participants where activity_id = ${id} and org_id = ${gate.user.orgId} order by user_id, contact_id, email, response`)).rows
    await tx.execute(sql`delete from crm_activity_participants where activity_id = ${id} and org_id = ${gate.user.orgId}`)
    await tx.execute(sql`delete from crm_activity_links where activity_id = ${id} and org_id = ${gate.user.orgId}`)
    const removed = await tx.execute(sql`delete from crm_activities where id = ${id} and org_id = ${gate.user.orgId} returning id`)
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'crm_activities', ${id}, 'delete', ${JSON.stringify({ before, links: linksBefore, participants: participantsBefore, after: null })}::jsonb, ${gate.user.id})`)
    return removed
  }) as unknown as { rows: unknown[] }
  return deleted.rows[0] ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
