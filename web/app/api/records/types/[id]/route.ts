import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { documentRevisionSql, isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { hasSubsidiaryField, loadRecordTypeById } from '../../../../../lib/records'
import { auditSetupChange } from '../../../../../lib/setup/audit'
import {
  describeIssue,
  lintRecordFields,
  typeKeyError,
} from '../../../../../lib/record-schema'
import type { FormSection } from '@openbooks/forms-core'

export const runtime = 'nodejs'

const ICON_KEY_RE = /^[a-z0-9-]{1,32}$/
const TYPE_REVISION_SQL = documentRevisionSql(sql`updated_at`)
const TYPE_REVISION_CONFLICT = {
  error: 'This record type changed after you opened it; reload the type and try again',
  code: 'revision_conflict',
} as const

function typeDeclaresSubsidiary(fields: unknown, name: string): boolean {
  const lint = lintRecordFields(fields, name)
  return lint.success && hasSubsidiaryField(lint.sections)
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const type = await loadRecordTypeById(gate.user.orgId, id)
  if (!type) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ type })
}

/**
 * Builder autosave. Saves partial edits even while the definition is
 * incomplete (a select with no options yet, an unfinished formula) and
 * returns the current lint `issues` — publishing is the gate that requires a
 * clean definition. The `fields` body carries the full FormSection[]
 * structure; structurally invalid payloads are rejected outright.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const type = await loadRecordTypeById(user.orgId, id)
  if (!type) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string
    pluralName?: string
    key?: string
    iconKey?: string
    description?: string | null
    fields?: unknown
    showInNav?: boolean
    allowedRoles?: string[] | null
    sortOrder?: number
    expectedUpdatedAt?: unknown
  }

  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200)) {
    return NextResponse.json({ error: 'Name must be 1–200 characters' }, { status: 422 })
  }
  if (
    body.pluralName !== undefined &&
    (typeof body.pluralName !== 'string' || !body.pluralName.trim() || body.pluralName.length > 200)
  ) {
    return NextResponse.json({ error: 'Plural name must be 1–200 characters' }, { status: 422 })
  }
  if (body.iconKey !== undefined && (typeof body.iconKey !== 'string' || !ICON_KEY_RE.test(body.iconKey))) {
    return NextResponse.json({ error: 'Invalid icon key' }, { status: 422 })
  }
  if (
    body.description !== undefined &&
    body.description !== null &&
    (typeof body.description !== 'string' || body.description.length > 2000)
  ) {
    return NextResponse.json({ error: 'Description must be at most 2,000 characters' }, { status: 422 })
  }
  if (
    body.allowedRoles !== undefined &&
    body.allowedRoles !== null &&
    (!Array.isArray(body.allowedRoles) ||
      body.allowedRoles.length > 50 ||
      body.allowedRoles.some((r) => typeof r !== 'string' || r.length === 0 || r.length > 100))
  ) {
    return NextResponse.json({ error: 'Invalid allowed roles' }, { status: 422 })
  }
  if (
    body.sortOrder !== undefined &&
    (!Number.isInteger(body.sortOrder) || Math.abs(body.sortOrder) > 100_000)
  ) {
    return NextResponse.json({ error: 'Invalid sort order' }, { status: 422 })
  }
  // show_in_nav rides raw into a boolean column: PostgreSQL would silently
  // coerce spellings like 'off'/'on' or throw 22P02 on anything else.
  if (body.showInNav !== undefined && typeof body.showInNav !== 'boolean') {
    return NextResponse.json({ error: 'Invalid show in nav flag' }, { status: 422 })
  }

  let key: string | undefined
  if (body.key !== undefined && body.key !== type.key) {
    if (type.status !== 'draft') {
      return NextResponse.json(
        { error: 'The key is pinned once a type has been published (records and numbering reference it)' },
        { status: 422 },
      )
    }
    if (typeof body.key !== 'string') return NextResponse.json({ error: 'Invalid key' }, { status: 422 })
    const keyIssue = typeKeyError(body.key)
    if (keyIssue) return NextResponse.json({ error: keyIssue }, { status: 422 })
    const clash = ((await db.execute(sql`
      select 1 from custom_record_types where org_id = ${user.orgId} and key = ${body.key} and id <> ${id}
    `)))
    if (clash.rows.length > 0) {
      return NextResponse.json({ error: `A record type with key "${body.key}" already exists` }, { status: 409 })
    }
    key = body.key
  }

  let fieldsJson: string | undefined
  let nextSections: FormSection[] | undefined
  let issues: { path: Array<string | number>; message: string }[] = []
  if (body.fields !== undefined) {
    const lint = lintRecordFields(body.fields, body.name ?? type.name)
    if (!lint.success) {
      return NextResponse.json(
        { error: `Invalid fields: ${lint.issues.slice(0, 3).map(describeIssue).join('; ')}`, issues: lint.issues },
        { status: 422 },
      )
    }
    // Persist the validated SECTION structure (not the flattened field list).
    fieldsJson = JSON.stringify(lint.sections)
    nextSections = lint.sections
    issues = lint.issues
  } else {
    // Re-lint the stored fields so a rename etc. still refreshes the issue list.
    issues = lintRecordFields(type.fields, body.name ?? type.name).issues
  }

  // Full-state builder saves must echo the revision they read. Substituting
  // the live server token would let a later tokenless autosave adopt a newer
  // revision and overwrite (or drop subsidiary_id from) a concurrent edit.
  if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
    return NextResponse.json(TYPE_REVISION_CONFLICT, { status: 409 })
  }
  const expectedRevision = body.expectedUpdatedAt
  const fence = gate.allowedSubsidiaryIds ?? null

  const outcome = await withOrgTransaction(user.orgId, async () => {
    // The full before-image rides the row lock: the audit event below must
    // show before/after of the configuration this save mutates (fields,
    // roles, key), and the image has to predate this transaction's own
    // UPDATE.
    const locked = (await db.execute<{ updated_at: string; fields: unknown; name: string; snapshot: Record<string, unknown> }>(sql`
      select ${TYPE_REVISION_SQL} as updated_at, fields, name,
             to_jsonb(custom_record_types) as snapshot
        from custom_record_types
       where id = ${id} and org_id = ${user.orgId}
       for update
    `)).rows[0]
    if (!locked) return { kind: 'not_found' as const }
    if (locked.updated_at !== expectedRevision) return { kind: 'conflict' as const }
    if (
      nextSections !== undefined &&
      fence !== null &&
      typeDeclaresSubsidiary(locked.fields, locked.name) &&
      !hasSubsidiaryField(nextSections)
    ) {
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          {
            error:
              'Keep the subsidiary_id field; removing it would expose records from subsidiaries outside your scope',
          },
          { status: 422 },
        ),
      }
    }
    const updated = await db.execute<{ snapshot: Record<string, unknown> }>(sql`
      update custom_record_types set
        name = coalesce(${body.name ?? null}, name),
        plural_name = coalesce(${body.pluralName ?? null}, plural_name),
        key = coalesce(${key ?? null}, key),
        icon_key = coalesce(${body.iconKey ?? null}, icon_key),
        description = ${body.description !== undefined ? body.description : sql`description`},
        fields = coalesce(${fieldsJson ?? null}::jsonb, fields),
        show_in_nav = coalesce(${body.showInNav ?? null}, show_in_nav),
        allowed_roles = ${body.allowedRoles !== undefined ? (body.allowedRoles === null ? null : JSON.stringify(body.allowedRoles)) : sql`allowed_roles`}${body.allowedRoles !== undefined ? sql`::jsonb` : sql``},
        sort_order = coalesce(${body.sortOrder ?? null}, sort_order),
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
        updated_by = ${user.id}
      where id = ${id} and org_id = ${user.orgId}
        and ${TYPE_REVISION_SQL} = ${expectedRevision}
      returning to_jsonb(custom_record_types) as snapshot
    `)
    if (updated.rows.length === 0) return { kind: 'conflict' as const }
    // Immutable configuration audit in the SAME transaction: a committed
    // builder save without its before/after evidence is a lost refusal
    // surface, so the audit write failing rolls the save back with it.
    await auditSetupChange({
      orgId: user.orgId,
      table: 'custom_record_types',
      rowId: id,
      action: 'update',
      changes: { before: locked.snapshot, after: updated.rows[0]!.snapshot },
      actorId: user.id,
    })
    return { kind: 'ok' as const }
  })
  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'conflict') return NextResponse.json(TYPE_REVISION_CONFLICT, { status: 409 })
  if (outcome.kind === 'response') return outcome.response

  const updated = await loadRecordTypeById(user.orgId, id)
  if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ type: updated, issues })
}

/** Delete a type — drafts only, and only before any record exists. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const outcome = await withOrgTransaction(user.orgId, async () => {
    const locked = (await db.execute<{ status: string; snapshot: Record<string, unknown> }>(sql`
      select status, to_jsonb(custom_record_types) as snapshot
        from custom_record_types
       where id = ${id} and org_id = ${user.orgId}
       for update
    `)).rows[0]
    if (!locked) return { kind: 'not_found' as const }
    if (locked.status !== 'draft') {
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          { error: 'Only draft types can be deleted — archive published types instead' },
          { status: 422 },
        ),
      }
    }
    const records = await db.execute(sql`
      select 1 from custom_records where org_id = ${user.orgId} and type_id = ${id} limit 1
    `)
    if (records.rows.length > 0) {
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          { error: 'This type already has records and cannot be deleted' },
          { status: 422 },
        ),
      }
    }
    const deleted = await db.execute(sql`
      delete from custom_record_types
       where id = ${id} and org_id = ${user.orgId} and status = 'draft'
         and not exists (
           select 1 from custom_records where org_id = ${user.orgId} and type_id = ${id}
         )
      returning id
    `)
    if (deleted.rows.length === 0) {
      const live = (await db.execute<{ status: string }>(sql`
        select status from custom_record_types
         where id = ${id} and org_id = ${user.orgId}
      `)).rows[0]
      if (!live) return { kind: 'not_found' as const }
      if (live.status !== 'draft') {
        return {
          kind: 'response' as const,
          response: NextResponse.json(
            { error: 'Only draft types can be deleted — archive published types instead' },
            { status: 422 },
          ),
        }
      }
      return {
        kind: 'response' as const,
        response: NextResponse.json(
          { error: 'This type already has records and cannot be deleted' },
          { status: 422 },
        ),
      }
    }
    // The deleted draft's configuration leaves an immutable delete event in
    // the same transaction (the before-image rode the row lock above), so a
    // removed type is still auditable after no read can observe it.
    await auditSetupChange({
      orgId: user.orgId,
      table: 'custom_record_types',
      rowId: id,
      action: 'delete',
      changes: { before: locked.snapshot },
      actorId: user.id,
    })
    return { kind: 'ok' as const }
  })
  if (outcome.kind === 'not_found') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'response') return outcome.response
  return NextResponse.json({ ok: true })
}
