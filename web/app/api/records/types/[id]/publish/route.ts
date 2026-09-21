import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { describeIssue, lintRecordFields, typeKeyError } from '../../../../../../lib/record-schema'

export const runtime = 'nodejs'

type LockedType = {
  id: string
  key: string
  name: string
  plural_name: string
  fields: unknown
  status: string
}

/**
 * Record-type lifecycle:
 *   publish — draft/archived → published. Requires a complete, lint-clean
 *             definition (name, plural, valid key, ≥1 field, no issues);
 *             the generated module goes live at /records/<key>.
 *   archive — published → archived. Records are kept but the module (and
 *             any nav entry) disappears; publish again to restore.
 *
 * Status is re-read under a row lock and the UPDATE is predicated on the
 * current status. A write that matches zero rows is a named refusal, never
 * `{ok:true}`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string }
  const action = body.action ?? 'publish'
  if (action !== 'archive' && action !== 'publish') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }

  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (await db.execute<LockedType>(sql`
      select id, key, name, plural_name, fields, status
        from custom_record_types
       where id = ${id} and org_id = ${user.orgId}
       for update
    `)).rows[0]
    if (!locked) return { kind: 'not_found' as const }

    if (action === 'archive') {
      if (locked.status !== 'published') {
        return {
          kind: 'response' as const,
          response: NextResponse.json({ error: 'Only published types can be archived' }, { status: 422 }),
        }
      }
      const archived = await db.execute(sql`
        update custom_record_types
           set status = 'archived',
               updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
               updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId} and status = 'published'
        returning id
      `)
      if (archived.rows.length === 0) {
        return {
          kind: 'response' as const,
          response: NextResponse.json({ error: 'Only published types can be archived' }, { status: 422 }),
        }
      }
      return { kind: 'ok' as const, status: 'archived' as const }
    }

    if (locked.status === 'published') {
      return {
        kind: 'response' as const,
        response: NextResponse.json({ error: 'Already published' }, { status: 422 }),
      }
    }

    const keyIssue = typeKeyError(locked.key)
    if (keyIssue) return { kind: 'response' as const, response: NextResponse.json({ error: `Key ${keyIssue}` }, { status: 422 }) }
    if (!locked.name.trim() || !locked.plural_name.trim()) {
      return {
        kind: 'response' as const,
        response: NextResponse.json({ error: 'Name and plural name are required' }, { status: 422 }),
      }
    }
    const lint = lintRecordFields(locked.fields, locked.name)
    if (!lint.success || lint.fields.length === 0) {
      return {
        kind: 'response' as const,
        response: NextResponse.json({ error: 'Add at least one field before publishing' }, { status: 422 }),
      }
    }
    if (lint.issues.length > 0) {
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          {
            error: `Resolve ${lint.issues.length} field issue${lint.issues.length === 1 ? '' : 's'} before publishing: ${lint.issues.slice(0, 3).map(describeIssue).join('; ')}`,
            issues: lint.issues,
          },
          { status: 422 },
        ),
      }
    }

    const published = await db.execute(sql`
      update custom_record_types
         set status = 'published',
             updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
             updated_by = ${user.id}
       where id = ${id} and org_id = ${user.orgId} and status in ('draft', 'archived')
      returning id
    `)
    if (published.rows.length === 0) {
      const live = (await db.execute<{ status: string }>(sql`
        select status from custom_record_types
         where id = ${id} and org_id = ${user.orgId}
      `)).rows[0]
      if (!live) return { kind: 'not_found' as const }
      if (live.status === 'published') {
        return {
          kind: 'response' as const,
          response: NextResponse.json({ error: 'Already published' }, { status: 422 }),
        }
      }
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          { error: 'This record type changed; reload the type and try again' },
          { status: 409 },
        ),
      }
    }
    return { kind: 'ok' as const, status: 'published' as const }
  })

  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'response') return outcome.response
  return NextResponse.json({ ok: true, status: outcome.status })
}
