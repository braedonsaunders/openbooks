import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { crmSubjectVisible, lockCrmLinkSubject } from '../../../../../lib/crm-scope'
import { parseJsonBody } from "@/lib/api/json"
import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.strictObject({
  kind: z.enum(['task', 'call', 'event', 'email', 'note']).optional(),
  subjectId: z.string().uuid().optional(),
  subjectKind: z.enum(['account', 'contact', 'opportunity', 'document', 'project']).optional(),
}).refine(
  (body) => (body.subjectKind === undefined) === (body.subjectId === undefined),
  { message: 'subjectKind and subjectId must be supplied together', path: ['subjectId'] },
)



export const runtime = 'nodejs'

export const POST = defineRoute({
  permission: 'crm.activities.manage',
  feature: 'crm',
  handler: async ({ request: req, authz: gate }) => {
    const { user } = gate
    if (gate.allowedSubsidiaryIds?.size === 0) return notFound("record")
    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data
    const kind = body.kind ?? 'task'
    const activity = await db.transaction(async (tx) => {
      if (body.subjectKind && body.subjectId) {
        // Lock the subject before checking visibility: the check must see the
        // latest committed subsidiary, and a concurrent rehome must block until
        // the link commits instead of slipping between the check and the insert.
        const exists = await lockCrmLinkSubject(tx, user.orgId, body.subjectKind, body.subjectId)
        const valid = exists
          ? await tx.execute(sql`select 1 where ${crmSubjectVisible(sql`${user.orgId}`,sql`${body.subjectKind}`,sql`${body.subjectId}`,gate.allowedSubsidiaryIds)}`)
          : { rows: [] }
        if (!valid.rows.length) return notFound("record")
      }
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
    if (activity instanceof NextResponse) return activity
    return NextResponse.json(activity)

  },
})
