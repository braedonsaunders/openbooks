import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { pgTextArrayLiteral } from '../../../../lib/pg-array'
import { subsidiaryDeclaredTypeIds } from '../../../../lib/records'
import { lintRecordFields, slugifyTypeKey, typeKeyError } from '../../../../lib/record-schema'
import { claimIdempotentCreate, resolveIdempotentReplay } from '../../../../lib/api/idempotency'
import { auditSetupChange } from '../../../../lib/setup/audit'

const ICON_KEY_RE = /^[a-z0-9-]{1,32}$/

const createTypeBodySchema = z.looseObject({
  name: z.string().optional(),
  pluralName: z.string().optional(),
  key: z.string().optional(),
  iconKey: z.string().optional(),
  description: z.string().nullable().optional(),
  fields: z.unknown().optional(),
  showInNav: z.boolean().optional(),
  allowedRoles: z.string().array().nullable().optional(),
  sortOrder: z.number().optional(),
})

export const runtime = 'nodejs'

/** All of the org's record types (builder data source). */
export async function GET() {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  // A subsidiary-restricted type manager sees only the records their fence
  // admits: types that declare subsidiary_id count in-fence rows; field-less
  // types stay org-visible unless a row still carries a JSON subsidiary_id
  // outside the fence (dropping the field must not unscope those rows).
  const fence = gate.allowedSubsidiaryIds
  const scopedTypeIds =
    fence === null
      ? null
      : subsidiaryDeclaredTypeIds(
          (
            await db.execute<{ id: string; name: string; fields: unknown }>(sql`
              select id, name, fields from custom_record_types where org_id = ${gate.user.orgId}`)
          ).rows,
        )
  const countScope =
    fence === null || scopedTypeIds === null
      ? sql``
      : sql`and (
          cr.data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral([...fence])}::text[])
          or (
            not (t.id = any(${`{${scopedTypeIds.join(',')}}`}::uuid[]))
            and cr.data ->> ${'subsidiary_id'} is null
          )
        )`
  const r = ((await db.execute(sql`
    select t.id, t.key, t.name, t.plural_name, t.icon_key, t.description, t.fields,
           t.status, t.show_in_nav, t.allowed_roles, t.sort_order, t.updated_at,
           (select count(*) from custom_records cr where cr.type_id = t.id ${countScope}) as record_count
      from custom_record_types t
     where t.org_id = ${gate.user.orgId}
     order by t.sort_order, t.name
  `)))
  return NextResponse.json({ types: r.rows })
}

/**
 * Explicit create for the type builder. The New button opens an UNSAVED
 * drawer (`?type=new`) and this endpoint runs only on Save: the caller
 * supplies a UUID idempotency key, which becomes the type id, so retrying
 * the same request returns the same type without a duplicate insert or
 * duplicate audit event. Cancel/close writes nothing — there is no draft.
 */
export async function POST(request: Request) {
  const gate = await guardPermission('records.manage_types')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  }

  const parsedBody = await parseJsonBody(request, createTypeBodySchema)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data

  const name = body.name?.trim() ?? ''
  if (!name || name.length > 200) {
    return NextResponse.json({ error: 'Name must be 1–200 characters' }, { status: 422 })
  }
  const pluralName = body.pluralName?.trim() ?? `${name}s`
  if (!pluralName || pluralName.length > 200) {
    return NextResponse.json({ error: 'Plural name must be 1–200 characters' }, { status: 422 })
  }
  const iconKey = body.iconKey ?? 'grid'
  if (!ICON_KEY_RE.test(iconKey)) {
    return NextResponse.json({ error: 'Invalid icon key' }, { status: 422 })
  }
  const description = body.description?.trim() || null
  if (description !== null && description.length > 2000) {
    return NextResponse.json({ error: 'Description must be at most 2,000 characters' }, { status: 422 })
  }
  const allowedRoles = body.allowedRoles ?? null
  if (
    allowedRoles !== null &&
    (allowedRoles.length > 50 ||
      allowedRoles.some((r) => typeof r !== 'string' || r.length === 0 || r.length > 100))
  ) {
    return NextResponse.json({ error: 'Invalid allowed roles' }, { status: 422 })
  }
  const sortOrder = body.sortOrder ?? 0
  if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 100_000) {
    return NextResponse.json({ error: 'Invalid sort order' }, { status: 422 })
  }
  if (body.showInNav !== undefined && typeof body.showInNav !== 'boolean') {
    return NextResponse.json({ error: 'Invalid show in nav flag' }, { status: 422 })
  }
  const showInNav = body.showInNav === true

  const lint = lintRecordFields(body.fields ?? [], name)
  if (!lint.success) {
    return NextResponse.json(
      {
        error: `Invalid fields: ${lint.issues.slice(0, 3).map((i) => i.message).join('; ')}`,
        issues: lint.issues,
      },
      { status: 422 },
    )
  }

  // A caller-supplied key is pinned exactly (clash is a 409, as on PATCH);
  // an omitted key derives from the name with the same -2/-3 suffix walk the
  // old draft factory used, so explicit Save never needs a placeholder.
  let key: string
  if (body.key !== undefined) {
    const keyIssue = typeKeyError(body.key)
    if (keyIssue) return NextResponse.json({ error: keyIssue }, { status: 422 })
    // The row's own id is excluded so an exact retry (same key, same id)
    // replays instead of tripping over itself.
    const clash = (await db.execute(sql`
      select 1 from custom_record_types
       where org_id = ${user.orgId} and key = ${body.key} and id <> ${requestId}
    `))
    if (clash.rows.length > 0) {
      return NextResponse.json(
        { error: `A record type with key "${body.key}" already exists` },
        { status: 409 },
      )
    }
    key = body.key
  } else {
    const base = slugifyTypeKey(name) || 'new-record-type'
    const taken = new Set(
      (
        await db.execute<{ key: string }>(sql`
          select key from custom_record_types
           where org_id = ${user.orgId} and id <> ${requestId}
             and (key = ${base} or key like ${base + '-%'})
        `)
      ).rows.map((r) => r.key),
    )
    key = base
    for (let n = 2; taken.has(key); n++) key = `${base}-${n}`
    const derivedIssue = typeKeyError(key)
    if (derivedIssue) return NextResponse.json({ error: derivedIssue }, { status: 422 })
  }

  // Full immutable create image for the audit event; the retry matcher is
  // the request-controlled subset (no derived or lifecycle state).
  const snapshot = {
    id: requestId,
    org_id: user.orgId,
    key,
    name,
    plural_name: pluralName,
    icon_key: iconKey,
    description,
    fields: lint.sections,
    show_in_nav: showInNav,
    allowed_roles: allowedRoles,
    sort_order: sortOrder,
  }
  const match = {
    key,
    name,
    plural_name: pluralName,
    icon_key: iconKey,
    description,
    fields: lint.sections,
    show_in_nav: showInNav,
    allowed_roles: allowedRoles,
    sort_order: sortOrder,
  }

  // One transaction for claim/insert/audit, following POST /api/accounts:
  // every statement carries org_id, so tenant isolation holds on the shared
  // pool exactly as the sibling PATCH/DELETE predicates do.
  return createType(requestId, user.orgId, user.id, key, pluralName, iconKey, description, showInNav, allowedRoles, sortOrder, lint.sections, snapshot, match)
}

async function createType(
  requestId: string,
  orgId: string,
  userId: string,
  key: string,
  pluralName: string,
  iconKey: string,
  description: string | null,
  showInNav: boolean,
  allowedRoles: string[] | null,
  sortOrder: number,
  sections: unknown,
  snapshot: Record<string, unknown>,
  match: Record<string, unknown>,
) {
  const outcome = await db.transaction(async (tx) => {
    const claim = await claimIdempotentCreate(tx, {
      orgId,
      table: 'custom_record_types',
      key: requestId,
    })
    if (claim === 'exists') {
      return resolveIdempotentReplay(tx, {
        orgId,
        table: 'custom_record_types',
        key: requestId,
        match,
      })
    }
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into custom_record_types
        (id, org_id, key, name, plural_name, icon_key, description, fields,
         status, show_in_nav, allowed_roles, sort_order, created_by, updated_by)
      values
        (${requestId}, ${orgId}, ${key}, ${snapshot.name as string}, ${pluralName},
         ${iconKey}, ${description}, ${JSON.stringify(sections)}::jsonb,
         'draft', ${showInNav}, ${allowedRoles ? JSON.stringify(allowedRoles) : null}::jsonb,
         ${sortOrder}, ${userId}, ${userId})
      on conflict (id) do nothing
      returning id
    `))
    if (!inserted.rows[0]) {
      return resolveIdempotentReplay(tx, {
        orgId,
        table: 'custom_record_types',
        key: requestId,
        match,
      })
    }
    await auditSetupChange(
      {
        orgId,
        table: 'custom_record_types',
        rowId: requestId,
        action: 'insert',
        changes: { before: null, after: snapshot },
        actorId: userId,
        requestId,
      },
      tx,
    )
    return 'fresh' as const
  })
  if (outcome === 'conflict') {
    return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
  }
  return NextResponse.json({ id: requestId }, { status: outcome === 'fresh' ? 201 : 200 })
}
