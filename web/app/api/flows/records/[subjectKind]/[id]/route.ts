import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { getFlowAdapter } from '@openbooks/engine/flows/registry'
import { db, withOrgTransaction } from '@openbooks/engine/platform/db'
import { uuidString } from '@openbooks/engine/platform/identifiers'
import { ScopeNotFoundError } from '@openbooks/engine/organization/scope'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { canReadSubjectRecord } from '@/lib/flow-subject-authz'
import { lockFlowSubjectScope, requireFlowsRecordReader } from '../../../_lib'

export const runtime = 'nodejs'

export interface ApprovalRequestDetail {
  subjectKind: string
  subjectId: string
  fields: Array<{ key: string; label: string; type: string; value: string | number | boolean | null }>
  submittedAt: string | null
  changed: boolean
}

/** The subject's own read grant and locked entity scope protect both current and retained terms. */
export const GET = defineRoute({
  public: 'session',
  params: z.strictObject({ subjectKind: z.string().min(1).max(100), id: uuidString() }),
  handler: async ({ params }) => {
    const session = await requireFlowsRecordReader()
    if (session instanceof NextResponse) return session
    const { authz } = session
    const { subjectKind, id } = params
    const adapter = getFlowAdapter(subjectKind)
    if (!adapter || adapter.scope.via === 'document'
      || !(await canReadSubjectRecord(authz, subjectKind, id))) return notFound('record')
    return withOrgTransaction(authz.user.orgId, async () => {
      try {
        await lockFlowSubjectScope(subjectKind, id, authz.user.orgId, authz.allowedSubsidiaryIds)
      } catch (error) {
        if (error instanceof ScopeNotFoundError) return notFound('record')
        throw error
      }
      const current = await adapter.loadContext(id)
      if (!current) return notFound('record')
      const receipt = (await db.execute<{ context: Record<string, unknown>; createdAt: Date | string; active: boolean }>(sql`
        select context, created_at as "createdAt", exists (
          select 1 from flow_gates g where g.org_id=flow_submissions.org_id
            and g.subject_kind=flow_submissions.subject_kind and g.subject_id=flow_submissions.subject_id
            and g.status in ('pending','escalated')) as active from flow_submissions
         where org_id=${authz.user.orgId} and subject_kind=${subjectKind} and subject_id=${id}
         order by created_at desc,id desc limit 1`)).rows[0]
      const values = receipt?.context ?? current.values
      const fields = adapter.profile.fields.flatMap(field => {
        const value = values[field.key]
        // User identities are already resolved by the shared approval history.
        // Internal references and object payloads are not record display fields.
        if (field.type === 'user' || field.key === 'id' || /Id$/.test(field.key) || field.key === 'event_source' || value === undefined
          || (value !== null && !['string', 'number', 'boolean'].includes(typeof value))) return []
        return [{ key: field.key, label: field.label, type: field.type,
          value: value as string | number | boolean | null }]
      })
      const command = values.command
      if (command && typeof command === 'object' && 'reason' in command && typeof command.reason === 'string') {
        fields.push({key:'commandReason',label:'Reason',type:'text',value:command.reason})
      }
      const submittedFingerprint = values.approvalFingerprint
      return Response.json({
        subjectKind, subjectId: id, fields,
        submittedAt: receipt ? new Date(receipt.createdAt).toISOString() : null,
        changed: receipt?.active === true && typeof submittedFingerprint === 'string'
          && typeof current.values.approvalFingerprint === 'string'
          && submittedFingerprint !== current.values.approvalFingerprint,
      } satisfies ApprovalRequestDetail)
    })
  },
})
