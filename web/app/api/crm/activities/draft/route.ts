import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const gate = await guardFeaturePermission('crm.activities.manage', 'crm')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { subjectKind?: string; subjectId?: string; kind?: string }
  const kind = ['task', 'call', 'event', 'email', 'note'].includes(body.kind ?? '') ? body.kind! : 'task'
  if ((body.subjectKind || body.subjectId) && (!body.subjectKind || !body.subjectId || !isUuid(body.subjectId))) {
    return NextResponse.json({ error: 'subjectKind and a valid subjectId are required together' }, { status: 422 })
  }
  const activity = await db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into crm_activities
        (org_id, kind, subject, status, owner_user_id, assigned_user_id, created_by, updated_by)
      values (${user.orgId}, ${kind}, 'New activity', 'planned', ${user.id}, ${user.id}, ${user.id}, ${user.id})
      returning id`))
    if (body.subjectKind && body.subjectId) {
      await tx.execute(sql`
        insert into crm_activity_links (org_id, activity_id, subject_kind, subject_id, created_by, updated_by)
        values (${user.orgId}, ${inserted.rows[0]!.id}, ${body.subjectKind}, ${body.subjectId}, ${user.id}, ${user.id})`)
    }
    return inserted.rows[0]!
  })
  return NextResponse.json(activity)
}
