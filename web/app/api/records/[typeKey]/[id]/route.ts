import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { runTriggerScripts } from '@openbooks/engine/src/scripting.ts'
import type { FieldValueMap } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { auditSetupChange } from '../../../../../lib/setup/audit'
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

async function loadScope(orgId: string, roleKeys: readonly string[], typeKey: string, id: string) {
  if (!isUuid(id)) return null
  const type = await loadRecordTypeByKey(orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(roleKeys, type.allowed_roles)) return null
  const record = await loadRecord(orgId, typeKey, id)
  if (!record) return null
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success) return null
  return { type, record, sections: lint.sections }
}

function mutationReason(value: unknown): string | null | NextResponse {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    return NextResponse.json({ error: 'reason must be a non-empty string of at most 500 characters' }, { status: 422 })
  }
  return value.trim()
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const gate = await guardPermission('records.read')
  if (gate instanceof NextResponse) return gate
  const { typeKey, id } = await params
  const scope = await loadScope(gate.user.orgId, gate.user.roles.map(({ key }) => key), typeKey, id)
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
  const scope = await loadScope(user.orgId, user.roles.map(({ key }) => key), typeKey, id)
  if (!scope) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { sections } = scope

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { data?: unknown; status?: string; reason?: unknown }
  const reason = mutationReason(body.reason)
  if (reason instanceof NextResponse) return reason

  // The lock, complete before-image, mutation, and immutable audit event all
  // share one tenant-pinned connection. A concurrent editor therefore waits
  // for this transaction and captures the committed row as its own before
  // image, while an audit failure rolls the mutation back with it.
  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (await db.execute<Record<string, unknown>>(sql`
      select * from custom_records
       where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
       for update
    `)).rows[0]
    if (!locked) return { kind: 'not_found' as const }
    const record = locked as typeof scope.record

    let nextStatus: RecordStatus | undefined
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'inactive') {
        return { kind: 'response' as const, response: NextResponse.json({ error: 'unknown status' }, { status: 422 }) }
      }
      const allowed: Record<RecordStatus, RecordStatus[]> = {
        draft: ['active'],
        active: ['inactive'],
        inactive: ['active'],
      }
      if (!allowed[record.status].includes(body.status)) {
        return {
          kind: 'response' as const,
          response: NextResponse.json(
            { error: `Cannot move a ${record.status} record to ${body.status}` },
            { status: 422 },
          ),
        }
      }
      nextStatus = body.status
    }

    // Values under ids that no longer exist on the type (the designer removed
    // a field or line list after records were saved) are silently dropped
    // rather than tripping the validator's unknown-key rejection.
    let nextData: FieldValueMap | undefined
    if (body.data !== undefined) {
      if (record.status === 'inactive' && nextStatus !== 'active') {
        return {
          kind: 'response' as const,
          response: NextResponse.json({ error: 'Reactivate this record before editing it' }, { status: 422 }),
        }
      }
      if (typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
        return { kind: 'response' as const, response: NextResponse.json({ error: 'data must be an object' }, { status: 422 }) }
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
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          {
            error:
              stage === 'submit' && errors.some((e) => e.message === 'Required')
                ? 'Fill every required field before activating'
                : errors[0]!.message,
            errors,
          },
          { status: 422 },
        ),
      }
    }

    // User scripts gate the save exactly as they gate a document submit. They
    // run while the row lock is held, so a script cannot observe a stale row.
    const orgRow = (await db.execute<{ id: string; name: string; base_currency: string }>(
      sql`select id, name, base_currency from orgs where id = ${user.orgId}`,
    ))
    const org = orgRow.rows[0]!
    const outcomes = await runTriggerScripts(
      'before_submit',
      {
        trigger: 'before_submit',
        document: {
          kind: `custrec:${typeKey}`,
          id: record.id,
          recordNumber: record.record_number,
          status: effectiveStatus,
          data: effectiveData,
        },
        org: { id: org.id, name: org.name, baseCurrency: org.base_currency },
        user: { id: user.id, name: user.name, roles: user.roles.map(({ key }) => key) },
      },
      record.id,
    )
    const blocked = outcomes.find((o) => o.status !== 'ok')
    if (blocked) {
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          { error: blocked.abortReason ?? `script "${blocked.name}" ${blocked.status}` },
          { status: 422 },
        ),
      }
    }

    const searchText =
      nextData !== undefined ? await buildSearchText(sections, nextData, record.record_number) : undefined
    const updated = (await db.execute<Record<string, unknown>>(sql`
      update custom_records set
        data = coalesce(${nextData !== undefined ? JSON.stringify(nextData) : null}::jsonb, data),
        search_text = coalesce(${searchText ?? null}, search_text),
        status = coalesce(${nextStatus ?? null}, status),
        updated_at = now(), updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
      returning *
    `)).rows[0]
    if (!updated) return { kind: 'not_found' as const }

    await auditSetupChange({
      orgId: user.orgId,
      table: 'custom_records',
      rowId: id,
      action: 'update',
      changes: {
        operation: nextStatus === undefined ? 'update' : 'lifecycle',
        reason,
        before: locked,
        after: updated,
      },
      actorId: user.id,
    })
    return { kind: 'updated' as const }
  })

  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'response') return outcome.response
  const updated = await loadRecord(user.orgId, typeKey, id)
  return NextResponse.json({ record: updated })
}

/** Drafts that never became real can be discarded. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ typeKey: string; id: string }> },
) {
  const gate = await guardPermission('records.create')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { typeKey, id } = await params
  const scope = await loadScope(user.orgId, user.roles.map(({ key }) => key), typeKey, id)
  if (!scope) return NextResponse.json({ error: 'not found' }, { status: 404 })
  let reason: string | null = null
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const parsedBody = await parseJsonBody(req, jsonObject)
    if (!parsedBody.ok) return parsedBody.response
    const parsedReason = mutationReason((parsedBody.data as { reason?: unknown }).reason)
    if (parsedReason instanceof NextResponse) return parsedReason
    reason = parsedReason
  }

  const outcome = await withOrgTransaction(user.orgId, async () => {
    const before = (await db.execute<Record<string, unknown>>(sql`
      select * from custom_records
       where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
       for update
    `)).rows[0]
    if (!before) return { kind: 'not_found' as const }
    if (before.status !== 'draft') {
      return { kind: 'protected' as const }
    }
    const deleted = (await db.execute<Record<string, unknown>>(sql`
      delete from custom_records
       where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
      returning *
    `)).rows[0]
    if (!deleted) return { kind: 'not_found' as const }
    await auditSetupChange({
      orgId: user.orgId,
      table: 'custom_records',
      rowId: id,
      action: 'delete',
      changes: { operation: 'delete', reason, before: deleted, after: null },
      actorId: user.id,
    })
    return { kind: 'deleted' as const }
  })
  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'protected') {
    return NextResponse.json({ error: 'Only draft records can be deleted — deactivate instead' }, { status: 422 })
  }
  return NextResponse.json({ ok: true })
}
