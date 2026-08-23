import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadRecordTypeById } from '../../../../../lib/records'
import {
  describeIssue,
  lintRecordFields,
  typeKeyError,
} from '../../../../../lib/record-schema'

export const runtime = 'nodejs'

const ICON_KEY_RE = /^[a-z0-9-]{1,32}$/

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
    const clash = (await db.execute(sql`
      select 1 from custom_record_types where org_id = ${user.orgId} and key = ${body.key} and id <> ${id}
    `)) as any
    if (clash.rows.length > 0) {
      return NextResponse.json({ error: `A record type with key "${body.key}" already exists` }, { status: 409 })
    }
    key = body.key
  }

  let fieldsJson: string | undefined
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
    issues = lint.issues
  } else {
    // Re-lint the stored fields so a rename etc. still refreshes the issue list.
    issues = lintRecordFields(type.fields, body.name ?? type.name).issues
  }

  await db.execute(sql`
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
      updated_at = now(), updated_by = ${user.id}
    where id = ${id} and org_id = ${user.orgId}
  `)

  const updated = await loadRecordTypeById(user.orgId, id)
  return NextResponse.json({ type: updated, issues })
}

/** Delete a type — drafts only, and only before any record exists. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const type = await loadRecordTypeById(user.orgId, id)
  if (!type) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (type.status !== 'draft') {
    return NextResponse.json({ error: 'Only draft types can be deleted — archive published types instead' }, { status: 422 })
  }
  const records = (await db.execute(sql`
    select 1 from custom_records where org_id = ${user.orgId} and type_id = ${id} limit 1
  `)) as any
  if (records.rows.length > 0) {
    return NextResponse.json({ error: 'This type already has records and cannot be deleted' }, { status: 422 })
  }
  await db.execute(sql`delete from custom_record_types where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
