import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { loadActivity } from '../../../../../lib/crm'

export const runtime = 'nodejs'

const KINDS = ['task', 'call', 'event', 'email', 'note']
const STATUSES = ['planned', 'in_progress', 'completed', 'cancelled']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function subjectExists(orgId: string, kind: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const result = kind === 'account'
    ? await db.execute(sql`select 1 from crm_account_profiles where org_id = ${orgId} and party_id = ${id}`)
    : kind === 'contact'
      ? await db.execute(sql`select 1 from contacts where org_id = ${orgId} and id = ${id}`)
      : kind === 'opportunity'
        ? await db.execute(sql`select 1 from crm_opportunities where org_id = ${orgId} and id = ${id}`)
        : kind === 'document'
          ? await db.execute(sql`select 1 from documents where org_id = ${orgId} and id = ${id}`)
          : kind === 'project'
            ? await db.execute(sql`select 1 from projects where org_id = ${orgId} and id = ${id}`)
            : { rows: [] }
  return (result as unknown as { rows: unknown[] }).rows.length === 1
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.activities.read', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const activity = isUuid(id) ? await loadActivity(id, gate.user.orgId) : null
  return activity ? NextResponse.json(activity) : NextResponse.json({ error: 'not found' }, { status: 404 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.activities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const current = (await db.execute(sql`select * from crm_activities where id = ${id} and org_id = ${user.orgId}`))
  if (!current.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data)
  if (body.kind !== undefined && !KINDS.includes(body.kind)) return NextResponse.json({ error: 'invalid activity kind' }, { status: 422 })
  if (body.status !== undefined && !STATUSES.includes(body.status)) return NextResponse.json({ error: 'invalid activity status' }, { status: 422 })
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority)) return NextResponse.json({ error: 'invalid priority' }, { status: 422 })
  if (body.subject !== undefined && !textOrNull(body.subject)) return NextResponse.json({ error: 'subject is required' }, { status: 422 })
  for (const key of ['ownerUserId', 'assignedUserId'] as const) {
    const value = body[key]
    if (value !== undefined && value !== null && (!isUuid(value) || !((await db.execute(sql`select 1 from users where id = ${value} and org_id = ${user.orgId}`))).rows[0])) {
      return NextResponse.json({ error: `invalid ${key}` }, { status: 422 })
    }
  }
  if (body.startsAt && body.endsAt && new Date(body.endsAt) < new Date(body.startsAt)) return NextResponse.json({ error: 'end must not precede start' }, { status: 422 })
  const duration = body.durationMinutes === undefined || body.durationMinutes === null || body.durationMinutes === '' ? null : Number(body.durationMinutes)
  if (duration !== null && (!Number.isInteger(duration) || duration < 0)) return NextResponse.json({ error: 'duration must be non-negative minutes' }, { status: 422 })
  const links = body.links as Array<{ subjectKind: string; subjectId: string }> | undefined
  if (links) {
    if (!Array.isArray(links)) return NextResponse.json({ error: 'links must be an array' }, { status: 422 })
    for (const link of links) if (!await subjectExists(user.orgId, link.subjectKind, link.subjectId)) return NextResponse.json({ error: 'invalid related record' }, { status: 422 })
  }
  const participants = body.participants as Array<{ userId?: string; contactId?: string; email?: string; response?: string }> | undefined
  if (participants && !Array.isArray(participants)) return NextResponse.json({ error: 'participants must be an array' }, { status: 422 })
  if (participants) for (const participant of participants) {
    const targets = [participant.userId, participant.contactId, textOrNull(participant.email)].filter(Boolean)
    if (targets.length !== 1) return NextResponse.json({ error: 'each participant must have exactly one target' }, { status: 422 })
    if (participant.userId && (!isUuid(participant.userId) || !((await db.execute(sql`select 1 from users where id = ${participant.userId} and org_id = ${user.orgId}`))).rows[0])) return NextResponse.json({ error: 'invalid participant user' }, { status: 422 })
    if (participant.contactId && (!isUuid(participant.contactId) || !((await db.execute(sql`select 1 from contacts where id = ${participant.contactId} and org_id = ${user.orgId}`))).rows[0])) return NextResponse.json({ error: 'invalid participant contact' }, { status: 422 })
  }

    await db.transaction(async (tx) => {
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
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${user.orgId}, 'crm_activities', ${id}, 'update', ${JSON.stringify({ before: current.rows[0], requested: body })}::jsonb, ${user.id})`)
  })
  return NextResponse.json(await loadActivity(id, user.orgId))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('crm.activities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const deleted = await db.transaction(async (tx) => {
    await tx.execute(sql`delete from crm_activity_participants where activity_id = ${id} and org_id = ${gate.user.orgId}`)
    await tx.execute(sql`delete from crm_activity_links where activity_id = ${id} and org_id = ${gate.user.orgId}`)
    return tx.execute(sql`delete from crm_activities where id = ${id} and org_id = ${gate.user.orgId} returning id`)
  }) as unknown as { rows: unknown[] }
  return deleted.rows[0] ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
