import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadRecordTypeById } from '../../../../../../lib/records'
import { describeIssue, lintRecordFields, typeKeyError } from '../../../../../../lib/record-schema'

export const runtime = 'nodejs'

/**
 * Record-type lifecycle:
 *   publish — draft/archived → published. Requires a complete, lint-clean
 *             definition (name, plural, valid key, ≥1 field, no issues);
 *             the generated module goes live at /records/<key>.
 *   archive — published → archived. Records are kept but the module (and
 *             any nav entry) disappears; publish again to restore.
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

  const type = await loadRecordTypeById(user.orgId, id)
  if (!type) return NextResponse.json({ error: 'not found' }, { status: 404 })

  if (action === 'archive') {
    if (type.status !== 'published') {
      return NextResponse.json({ error: 'Only published types can be archived' }, { status: 422 })
    }
    await db.execute(sql`
      update custom_record_types set status = 'archived', updated_at = now(), updated_by = ${user.id}
       where id = ${id} and org_id = ${user.orgId}
    `)
    return NextResponse.json({ ok: true, status: 'archived' })
  }

  if (action !== 'publish') {
    return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  }
  if (type.status === 'published') {
    return NextResponse.json({ error: 'Already published' }, { status: 422 })
  }

  const keyIssue = typeKeyError(type.key)
  if (keyIssue) return NextResponse.json({ error: `Key ${keyIssue}` }, { status: 422 })
  if (!type.name.trim() || !type.plural_name.trim()) {
    return NextResponse.json({ error: 'Name and plural name are required' }, { status: 422 })
  }
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success || lint.fields.length === 0) {
    return NextResponse.json({ error: 'Add at least one field before publishing' }, { status: 422 })
  }
  if (lint.issues.length > 0) {
    return NextResponse.json(
      {
        error: `Resolve ${lint.issues.length} field issue${lint.issues.length === 1 ? '' : 's'} before publishing: ${lint.issues.slice(0, 3).map(describeIssue).join('; ')}`,
        issues: lint.issues,
      },
      { status: 422 },
    )
  }

  await db.execute(sql`
    update custom_record_types set status = 'published', updated_at = now(), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true, status: 'published' })
}
