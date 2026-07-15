import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FieldValueMap } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import {
  buildSearchText,
  inTypeAudience,
  loadRecord,
  loadRecordTypeByKey,
} from '../../../../../lib/records'
import {
  lintRecordFields,
  stripUnknownData,
  validateRecordData,
  withComputedFormulas,
  type RecordStatus,
} from '../../../../../lib/record-schema'

export const runtime = 'nodejs'

async function loadScope(orgId: string, role: string, typeKey: string, id: string) {
  if (!isUuid(id)) return null
  const type = await loadRecordTypeByKey(orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(role, type.allowed_roles)) return null
  const record = await loadRecord(orgId, typeKey, id)
  if (!record) return null
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success) return null
  return { type, record, sections: lint.sections }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const gate = await guardPermission('records.read')
  if (gate instanceof NextResponse) return gate
  const { typeKey, id } = await params
  const scope = await loadScope(gate.user.orgId, gate.user.role, typeKey, id)
  if (!scope) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ record: scope.record })
}

/**
 * Autosave + lifecycle for a custom record.
 *
 *   { data }             — validate against the type's fields (forms-core
 *                          validators; unknown keys rejected), recompute
 *                          formula values, refresh the search text. Draft
 *                          stage relaxes required checks; an ACTIVE record
 *                          must stay submit-valid (records are master data
 *                          and remain editable while active).
 *   { status }           — draft → active (enforces required fields),
 *                          active → inactive, inactive → active.
 *
 * Both may be sent together; data is applied first, then the transition
 * validates the merged payload.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const gate = await guardPermission('records.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { typeKey, id } = await params
  const scope = await loadScope(user.orgId, user.role, typeKey, id)
  if (!scope) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { record, sections } = scope

  const body = (await req.json()) as { data?: unknown; status?: string }

  let nextStatus: RecordStatus | undefined
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'inactive') {
      return NextResponse.json({ error: 'unknown status' }, { status: 422 })
    }
    const allowed: Record<RecordStatus, RecordStatus[]> = {
      draft: ['active'],
      active: ['inactive'],
      inactive: ['active'],
    }
    if (!allowed[record.status].includes(body.status)) {
      return NextResponse.json(
        { error: `Cannot move a ${record.status} record to ${body.status}` },
        { status: 422 },
      )
    }
    nextStatus = body.status
  }

  // Values under ids that no longer exist on the type (the designer removed a
  // field or line list after records were saved) are silently dropped rather
  // than tripping the validator's unknown-key rejection — header fields,
  // repeating-section keys, and unknown row-field keys alike.
  let nextData: FieldValueMap | undefined
  if (body.data !== undefined) {
    if (record.status === 'inactive' && nextStatus !== 'active') {
      return NextResponse.json({ error: 'Reactivate this record before editing it' }, { status: 422 })
    }
    if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
      return NextResponse.json({ error: 'data must be an object' }, { status: 422 })
    }
    nextData = withComputedFormulas(sections, stripUnknownData(sections, body.data as FieldValueMap))
  }

  // Value validation: supplied values must always be VALID; required fields
  // are enforced whenever the record is (or is becoming) active.
  const effectiveData = nextData ?? stripUnknownData(sections, record.data)
  const effectiveStatus = nextStatus ?? record.status
  const stage = effectiveStatus === 'active' ? 'submit' : 'draft'
  const errors = validateRecordData(sections, effectiveData, stage)
  if (errors.length > 0) {
    return NextResponse.json(
      {
        error:
          stage === 'submit' && errors.some((e) => e.message === 'Required')
            ? 'Fill every required field before activating'
            : errors[0]!.message,
        errors,
      },
      { status: 422 },
    )
  }

  const searchText =
    nextData !== undefined ? await buildSearchText(sections, nextData, record.record_number) : undefined

  await db.execute(sql`
    update custom_records set
      data = coalesce(${nextData !== undefined ? JSON.stringify(nextData) : null}::jsonb, data),
      search_text = coalesce(${searchText ?? null}, search_text),
      status = coalesce(${nextStatus ?? null}, status),
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
  `)

  const updated = await loadRecord(user.orgId, typeKey, id)
  return NextResponse.json({ record: updated })
}

/** Drafts that never became real can be discarded. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const gate = await guardPermission('records.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { typeKey, id } = await params
  const scope = await loadScope(user.orgId, user.role, typeKey, id)
  if (!scope) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (scope.record.status !== 'draft') {
    return NextResponse.json({ error: 'Only draft records can be deleted — deactivate instead' }, { status: 422 })
  }
  await db.execute(sql`delete from custom_records where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
