import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import {
  computeNextRunAt,
  normalizeReportRecipientEmails,
  validateCadenceInput,
} from '@openbooks/reports'
import { loadReportDefinition } from '../../../../../lib/custom-reports'
import { canAccessReportArtifact, canAccessReportDefinition } from '../../../../../lib/report-execution-context'
import { isUuid } from '../../../../../lib/list-params'
import { notFound } from "@/lib/api/responses";
const PATCHBodySchema1 = z.object({ "cadence": z.unknown().optional(), "dayOfWeek": z.unknown().optional(), "dayOfMonth": z.unknown().optional(), "hour": z.unknown().optional(), "minute": z.unknown().optional(), "timezone": z.unknown().optional(), "recipientEmails": z.unknown().optional(), "active": z.boolean().optional(), "reason": z.unknown().optional() }).passthrough();



export const runtime = 'nodejs'

type ScheduleRow = {
  id: string
  definition_id: string
  cadence: 'daily' | 'weekly' | 'monthly'
  day_of_week: number | null
  day_of_month: number | null
  hour: number
  minute: number
  timezone: string
  recipient_emails: string[]
  next_run_at: string
  active: boolean
  [key: string]: unknown
}

/** Client-supplied reason, or a deterministic fallback for existing callers. */
function scheduleReason(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 500) : fallback
}

/** Update cadence/recipients/active. Any cadence change recomputes next_run_at. */
export const PATCH = defineRoute({
  permission: 'reports.schedule',
  feature: { none: "This always-on route is governed by reports.schedule; the existing route has no separate feature gate." },
  body: PATCHBodySchema1,
  handler: async ({ request: req, authz: routeAuthz, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")

    const body = (routeBody) as {
        cadence?: unknown
        dayOfWeek?: unknown
        dayOfMonth?: unknown
        hour?: unknown
        minute?: unknown
        timezone?: unknown
        recipientEmails?: unknown
        active?: boolean
        reason?: unknown
      }
    return withOrgTransaction(user.orgId, async () => {
        // Lock and snapshot the tenant-owned row before deriving any fallback
        // values. The mutation and its audit evidence then share this pinned
        // transaction, so a concurrent edit cannot be silently overwritten.
        const existing = (await db.execute<ScheduleRow>(sql`
          select * from report_schedules
           where id = ${id} and org_id = ${user.orgId}
           for update
        `)).rows[0]
        if (!existing) return notFound("record")
        const def = await loadReportDefinition(user.orgId, existing.definition_id)
        if (!def || !(await canAccessReportDefinition(gate, def))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })
        if (existing.authorization_snapshot != null && !(await canAccessReportArtifact(gate, existing.authorization_snapshot))) return NextResponse.json({ error: 'original report scope access denied' }, { status: 403 })

        // Re-validate the whole cadence (falling back to the locked stored values)
        // so a partial edit never yields an inconsistent day pair.
        let cadence
        let recipients: string[]
        try {
          cadence = validateCadenceInput({
            cadence: body.cadence ?? existing.cadence,
            dayOfWeek: body.dayOfWeek ?? existing.day_of_week,
            dayOfMonth: body.dayOfMonth ?? existing.day_of_month,
            hour: body.hour ?? existing.hour,
            minute: body.minute ?? existing.minute,
            timezone: body.timezone ?? existing.timezone,
          })
          recipients = normalizeReportRecipientEmails(
            Array.isArray(body.recipientEmails)
              ? (body.recipientEmails as string[])
              : existing.recipient_emails,
          )
        } catch (err) {
          return apiErrorResponse(err, { safeStatus: 422 })
        }
        const active = body.active !== undefined ? body.active : existing.active
        if (active && recipients.length === 0) {
          return NextResponse.json({ error: 'At least one recipient is required for an active schedule' }, { status: 422 })
        }
        const nextRunAt = computeNextRunAt(cadence)
        // Cadence, recipients, and active are editable. authorization_snapshot is
        // the original pin (principal + allowedSubsidiaryIds; null = every legal
        // entity). scheduledReportAuthz reuses that pin; later grants cannot
        // widen it. An editor who canAccessReportArtifact of a narrower pin must
        // not replace it with snapshotReportAuthorization of their current
        // allowlist — that is how an org-unrestricted reports.schedule editor
        // would persist allowedSubsidiaryIds: null over a restricted schedule.
        const updated = (await db.execute<ScheduleRow>(sql`
          update report_schedules set
            cadence = ${cadence.cadence}, day_of_week = ${cadence.dayOfWeek}, day_of_month = ${cadence.dayOfMonth},
            hour = ${cadence.hour}, minute = ${cadence.minute}, timezone = ${cadence.timezone},
            recipient_emails = ${JSON.stringify(recipients)}::jsonb,
            next_run_at = ${nextRunAt.toISOString()}, active = ${active},
            updated_at = now(), updated_by = ${user.id}
          where id = ${id} and org_id = ${user.orgId}
          returning *
        `)).rows[0]
        if (!updated) return notFound("record")

        await db.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
          values
            (${user.orgId}, 'report_schedules', ${id}, 'update',
             ${JSON.stringify({
               reason: scheduleReason(body.reason, 'report schedule updated'),
               before: existing,
               after: updated,
             })}::jsonb,
             ${user.id}, now(), ${req.headers.get('X-Request-Id')})
        `)
        return NextResponse.json({ schedule: updated })
      })
  },
});

export const DELETE = defineRoute({
  permission: 'reports.schedule',
  feature: { none: "This always-on route is governed by reports.schedule; the existing route has no separate feature gate." },
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const { user } = gate
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    let reason: unknown
    const raw = await req.text().catch(() => '')
    if (raw.trim().length > 0) {
        const routeBodySchema2 = z.object({  }).passthrough();
    const parsedBody = await parseJsonBody(
          new Request('http://internal/schedule-delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: raw,
          }),
          routeBodySchema2,
        )
        if (!parsedBody.ok) return parsedBody.response
        reason = (parsedBody.data as { reason?: unknown }).reason
      }
    return withOrgTransaction(user.orgId, async () => {
        // A delete is terminal for the schedule's delivery configuration. Keep the
        // exact locked row in the same transaction as both the delete and audit.
        const existing = (await db.execute<ScheduleRow>(sql`
          select * from report_schedules
           where id = ${id} and org_id = ${user.orgId}
           for update
        `)).rows[0]
        if (!existing) return notFound("record")
        const def = await loadReportDefinition(user.orgId, existing.definition_id)
        if (!def || !(await canAccessReportDefinition(gate, def))) return NextResponse.json({ error: 'report access denied' }, { status: 403 })
        if (existing.authorization_snapshot != null && !(await canAccessReportArtifact(gate, existing.authorization_snapshot))) return NextResponse.json({ error: 'original report scope access denied' }, { status: 403 })

        await db.execute(sql`
          delete from report_schedules where id = ${id} and org_id = ${user.orgId}
        `)
        await db.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id, at, request_id)
          values
            (${user.orgId}, 'report_schedules', ${id}, 'delete',
             ${JSON.stringify({
               reason: scheduleReason(reason, 'report schedule deleted'),
               before: existing,
               after: null,
             })}::jsonb,
             ${user.id}, now(), ${req.headers.get('X-Request-Id')})
        `)
        return NextResponse.json({ ok: true })
      })
  },
});
