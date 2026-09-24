import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { documentRevisionCounterSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { runTriggerScripts } from '@openbooks/engine/src/scripting/scripting.ts'
import type { FieldValueMap, FormSection } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { auditSetupChange } from '../../../../../lib/setup/audit'
import {
  buildSearchText,
  inTypeAudience,
  loadRecord,
  loadRecordTypeByKey,
  recordVisibleInSubsidiaryFence,
  retainStoredSubsidiaryId,
} from '../../../../../lib/records'
import {
  findUnknownDataKeys,
  lintRecordFields,
  stripUnknownData,
  validateRecordData,
  withComputedFormulas,
  type RecordStatus,
} from '../../../../../lib/record-schema'

export const runtime = 'nodejs'

async function loadScope(
  orgId: string,
  roleKeys: readonly string[],
  typeKey: string,
  id: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  if (!isUuid(id)) return null
  const type = await loadRecordTypeByKey(orgId, typeKey)
  if (!type || type.status !== 'published' || !inTypeAudience(roleKeys, type.allowed_roles)) return null
  const record = await loadRecord(orgId, typeKey, id)
  if (!record) return null
  const lint = lintRecordFields(type.fields, type.name)
  if (!lint.success) return null
  if (!recordVisibleInSubsidiaryFence(lint.sections, record.data, allowedSubsidiaryIds)) return null
  return { type, record, sections: lint.sections }
}

const RECORD_REFERENCE_TABLES: Record<string, string> = {
  party: 'parties',
  gl_account: 'accounts',
}

const RECORD_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Same ownership fence as web/lib/api/writers.ts findUnownedRecordReferences:
 * party → parties.id and gl_account → accounts.id must belong to this org.
 * Keep these aligned.
 */
async function findUnownedRecordReferences(
  orgId: string,
  sections: FormSection[],
  data: FieldValueMap,
): Promise<string[]> {
  const wanted = new Map<string, { field: string; value: string }[]>()
  const collect = (fieldId: string, fieldType: string, raw: unknown) => {
    const refTable = RECORD_REFERENCE_TABLES[fieldType]
    if (!refTable || typeof raw !== 'string' || !RECORD_UUID_RE.test(raw)) return
    const list = wanted.get(refTable) ?? []
    list.push({ field: fieldId, value: raw })
    wanted.set(refTable, list)
  }
  for (const section of sections) {
    if (section.repeating) {
      const rows = data[section.id]
      if (!Array.isArray(rows)) continue
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue
        for (const field of section.fields) {
          collect(field.id, field.type, (row as FieldValueMap)[field.id])
        }
      }
      continue
    }
    for (const field of section.fields) {
      collect(field.id, field.type, data[field.id])
    }
  }
  const unowned: string[] = []
  for (const [refTable, entries] of wanted) {
    const ids = [...new Set(entries.map((e) => e.value))]
    const owned = new Set(
      (
        await db.execute<{ id: string }>(sql`
          select id from ${sql.raw(`"${refTable}"`)}
           where org_id = ${orgId} and id = any(${`{${ids.join(',')}}`}::uuid[])`)
      ).rows.map((r) => r.id),
    )
    for (const entry of entries) {
      if (!owned.has(entry.value)) unowned.push(entry.field)
    }
  }
  return unowned
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
  const scope = await loadScope(
    gate.user.orgId,
    gate.user.roles.map(({ key }) => key),
    typeKey,
    id,
    gate.allowedSubsidiaryIds,
  )
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
  const scope = await loadScope(
    user.orgId,
    user.roles.map(({ key }) => key),
    typeKey,
    id,
    gate.allowedSubsidiaryIds,
  )
  if (!scope) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const { sections } = scope

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { data?: unknown; status?: string; reason?: unknown; expectedUpdatedAt?: unknown }
  const reason = mutationReason(body.reason)
  if (reason instanceof NextResponse) return reason
  // Mandatory optimistic-concurrency evidence on data-bearing saves (same
  // contract as document and payment edits): two tabs replacing one data bag
  // must 409 instead of silently overwriting each other. Checked after the
  // scope gate so a missing token never leaks record existence to an
  // unauthorized caller. Lifecycle-only transitions stay on their status
  // machine (a conditional move the lock re-validates), not on a token.
  if (body.data !== undefined && !isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json(
      { error: 'A current record revision is required; reload the record and try again', code: 'revision_conflict' },
      { status: 409 },
    )
  }

  // The lock, complete before-image, mutation, and immutable audit event all
  // share one tenant-pinned connection. A concurrent editor therefore waits
  // for this transaction and captures the committed row as its own before
  // image, while an audit failure rolls the mutation back with it.
  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (await db.execute<Record<string, unknown> & { revision?: unknown }>(sql`
      select *, ${documentRevisionCounterSql(sql`revision_seq`)} as revision from custom_records
       where id = ${id} and org_id = ${user.orgId} and type_key = ${typeKey}
       for update
    `)).rows[0]
    if (!locked) return { kind: 'not_found' as const }
    const record = locked as typeof scope.record
    if (!recordVisibleInSubsidiaryFence(sections, record.data, gate.allowedSubsidiaryIds)) {
      return { kind: 'not_found' as const }
    }
    // The token is compared against the row locked by this write transaction,
    // never against the pre-lock snapshot above (which may have gone stale
    // while validation-unrelated work ran between the gate and this lock).
    if (body.data !== undefined && locked.revision !== body.expectedUpdatedAt) {
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          {
            error: 'This record changed after you opened it; reload the record and reapply your changes',
            code: 'revision_conflict',
          },
          { status: 409 },
        ),
      }
    }

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
      // Unknown ids are refused BEFORE stripping: strip-then-validate
      // silently drops them with success and the validator never sees them.
      // (Values under ids the designer removed are still tolerated on the
      // STORED row — strippedData below — only newly supplied data refuses.)
      const unknownFields = findUnknownDataKeys(sections, body.data as FieldValueMap)
      if (unknownFields.length > 0) {
        return {
          kind: 'response' as const,
          response: NextResponse.json(
            {
              error: `Unknown field${unknownFields.length === 1 ? '' : 's'} ${unknownFields.map((f) => `"${f}"`).join(', ')}: remove ${unknownFields.length === 1 ? 'it' : 'them'} from data or ask the designer to add ${unknownFields.length === 1 ? 'the field' : 'the fields'} to the record type`,
              unknownFields,
            },
            { status: 422 },
          ),
        }
      }
      nextData = withComputedFormulas(sections, stripUnknownData(sections, body.data as FieldValueMap))
    }

    // Value validation: supplied values must always be VALID; required fields
    // are enforced whenever the record is (or is becoming) active. Persist the
    // retained bag so a dropped subsidiary_id field cannot erase the stored
    // JSON fence token (same as writers.ts).
    const strippedData = nextData ?? stripUnknownData(sections, record.data)
    const persistedData = retainStoredSubsidiaryId(sections, record.data as FieldValueMap, strippedData)
    if (nextData !== undefined) nextData = persistedData
    const effectiveData = strippedData
    const effectiveStatus = nextStatus ?? record.status
    if (!recordVisibleInSubsidiaryFence(sections, persistedData, gate.allowedSubsidiaryIds)) {
      return { kind: 'not_found' as const }
    }
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
            // Machine-readable twin of `errors` for the shared action path:
            // the client branches on `code`/status and renders `issues`,
            // never on message text.
            issues: errors.map((e) => ({ path: e.fieldId, message: e.message })),
          },
          { status: 422 },
        ),
      }
    }

    // Picker values are uuid-SHAPED at this point but nothing proves the
    // referenced row belongs to the caller: refuse foreign or dangling ids
    // with a tenant-opaque 404 instead of persisting a cross-tenant pointer.
    // Ownership applies to newly supplied references only.
    if (
      nextData !== undefined &&
      typeof body.data === 'object' &&
      body.data !== null &&
      !Array.isArray(body.data)
    ) {
      const supplied: FieldValueMap = {}
      for (const key of Object.keys(body.data as FieldValueMap)) {
        if (nextData[key] !== undefined) supplied[key] = nextData[key]
      }
      const unownedRecordRefs = await findUnownedRecordReferences(user.orgId, sections, supplied)
      if (unownedRecordRefs.length > 0) {
        const field = unownedRecordRefs[0]!
        return {
          kind: 'response' as const,
          response: NextResponse.json(
            {
              error: `${field} not found in this organization`,
              fieldErrors: [{ field, message: 'not found in this organization' }],
            },
            { status: 404 },
          ),
        }
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
      nextData !== undefined ? await buildSearchText(user.orgId, sections, nextData, record.record_number) : undefined
    // Monotonic revision advance (same idiom as document and prebill-line
    // writers): every committed update moves the token forward, so equal
    // strings really do mean "nothing changed since you read it".
    const updated = (await db.execute<Record<string, unknown>>(sql`
      update custom_records set
        data = coalesce(${nextData !== undefined ? JSON.stringify(nextData) : null}::jsonb, data),
        search_text = coalesce(${searchText ?? null}, search_text),
        status = coalesce(${nextStatus ?? null}, status),
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
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
  const scope = await loadScope(
    user.orgId,
    user.roles.map(({ key }) => key),
    typeKey,
    id,
    gate.allowedSubsidiaryIds,
  )
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
    if (!recordVisibleInSubsidiaryFence(scope.sections, before.data as FieldValueMap, gate.allowedSubsidiaryIds)) {
      return { kind: 'not_found' as const }
    }
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
