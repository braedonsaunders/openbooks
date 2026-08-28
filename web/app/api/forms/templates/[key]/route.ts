import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { parseFormSchema } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../lib/authz'
import { getLatestVersion, getTemplateByKey } from '../../_lib'

export const runtime = 'nodejs'

type Params = { params: Promise<{ key: string }> }

/** Template meta + all versions + the editable draft schema. */
export async function GET(_req: Request, { params }: Params) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { key } = await params

  const template = await getTemplateByKey(user.orgId, key)
  if (!template) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const versions = ((await db.execute(sql`
    select id, version, changelog, published_at, created_at
      from form_template_versions
     where org_id = ${user.orgId} and template_id = ${template.id}
     order by version desc
  `)))
  const latest = await getLatestVersion(user.orgId, template.id)

  return NextResponse.json({
    template,
    versions: versions.rows,
    // The designer edits the latest version's schema; whether that row is a
    // mutable draft or a published snapshot (⇒ save spawns version n+1).
    draft: latest
      ? { version: latest.version, schema: latest.schema, isPublished: !!latest.published_at }
      : null,
  })
}

/** Update template meta and/or save the draft schema. */
export async function PUT(req: Request, { params }: Params) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { key } = await params

  const template = await getTemplateByKey(user.orgId, key)
  if (!template) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string
    category?: string | null
    description?: string | null
    kind?: string
    allowedRoles?: string[] | null
    schema?: unknown
  }

  const hasMetadataChanges =
    body.name !== undefined ||
    body.category !== undefined ||
    body.description !== undefined ||
    body.kind !== undefined ||
    body.allowedRoles !== undefined

  // Validate the schema before opening the write transaction. This keeps a
  // request that combines metadata and an invalid schema entirely read-only.
  const parsedSchema = body.schema === undefined ? undefined : parseFormSchema(body.schema)
  if (parsedSchema && !parsedSchema.success) {
    return NextResponse.json({ error: 'invalid schema', issues: parsedSchema.issues }, { status: 422 })
  }

  let savedVersion: number | null = null
  if (hasMetadataChanges || parsedSchema) {
    await db.transaction(async (tx) => {
      if (hasMetadataChanges) {
        const name = body.name?.trim() || template.name
        const kind = ['form', 'wizard', 'checklist', 'register'].includes(body.kind ?? '')
          ? body.kind
          : template.kind
        const allowedRoles =
          body.allowedRoles === undefined
            ? template.allowed_roles
            : Array.isArray(body.allowedRoles) && body.allowedRoles.length > 0
              ? body.allowedRoles.map((r) => String(r)).slice(0, 20)
              : null
        await tx.execute(sql`
          update form_templates
             set name = ${name},
                 category = ${body.category === undefined ? template.category : body.category?.trim() || null},
                 description = ${body.description === undefined ? template.description : body.description?.trim() || null},
                 kind = ${kind},
                 allowed_roles = ${allowedRoles === null ? null : JSON.stringify(allowedRoles)}::jsonb,
                 updated_at = now(), updated_by = ${user.id}
           where id = ${template.id} and org_id = ${user.orgId}
        `)
      }

      if (parsedSchema) {
        const latestResult = await tx.execute(sql`
          select id, version, published_at
            from form_template_versions
           where org_id = ${user.orgId} and template_id = ${template.id}
           order by version desc limit 1
        `)
        const latest = latestResult.rows[0] as
          | { id: string; version: number; published_at: string | null }
          | undefined
        if (latest && !latest.published_at) {
          // Editable draft — update in place.
          await tx.execute(sql`
            update form_template_versions
               set schema = ${JSON.stringify(parsedSchema.data)}::jsonb,
                   updated_at = now(), updated_by = ${user.id}
             where id = ${latest.id} and org_id = ${user.orgId}
          `)
          savedVersion = latest.version
        } else {
          // Latest is published (immutable) or missing — spawn the next draft.
          const next = (latest?.version ?? 0) + 1
          await tx.execute(sql`
            insert into form_template_versions (org_id, template_id, version, schema, created_by, updated_by)
            values (${user.orgId}, ${template.id}, ${next},
                    ${JSON.stringify(parsedSchema.data)}::jsonb, ${user.id}, ${user.id})
          `)
          savedVersion = next
        }
      }
    })
  }

  return NextResponse.json({ ok: true, savedVersion })
}

/** Archive (soft-retire) a template. Responses and versions are kept. */
export async function DELETE(_req: Request, { params }: Params) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { key } = await params

  const template = await getTemplateByKey(user.orgId, key)
  if (!template) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await db.execute(sql`
    update form_templates
       set status = 'archived', updated_at = now(), updated_by = ${user.id}
     where id = ${template.id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}
