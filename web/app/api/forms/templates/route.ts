import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { emptyFormSchema } from '@openbooks/forms-core'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const KINDS = new Set(['form', 'wizard', 'checklist', 'register'])

/** List templates with latest-version + response rollups. */
export async function GET() {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const r = (await db.execute(sql`
    select t.id, t.key, t.name, t.category, t.description, t.status, t.kind,
           t.allowed_roles, t.updated_at,
           v.max_version, v.version_count, v.published_version,
           coalesce(rc.n, 0) as response_count
      from form_templates t
      left join lateral (
        select max(version) as max_version,
               count(*) as version_count,
               max(version) filter (where published_at is not null) as published_version
          from form_template_versions where template_id = t.id
      ) v on true
      left join lateral (
        select count(*) as n from form_responses
         where org_id = t.org_id and template_key = t.key and status <> 'draft'
      ) rc on true
     where t.org_id = ${user.orgId}
     order by t.status = 'archived', t.name
  `)) as any

  return NextResponse.json({ templates: r.rows })
}

/** Create a template + its version-1 draft schema. */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    key?: string
    name?: string
    kind?: string
    category?: string
    description?: string
  }
  const name = body.name?.trim()
  const key = body.key?.trim().toLowerCase()
  if (!name || !key) {
    return NextResponse.json({ error: 'name and key are required' }, { status: 400 })
  }
  if (!KEY_RE.test(key)) {
    return NextResponse.json(
      { error: 'key must be 2–64 chars: lowercase letters, numbers, hyphens' },
      { status: 400 },
    )
  }
  const kind = body.kind && KINDS.has(body.kind) ? body.kind : 'form'

  const dupe = (await db.execute(sql`
    select 1 from form_templates where org_id = ${user.orgId} and key = ${key}
  `)) as any
  if (dupe.rows.length > 0) {
    return NextResponse.json({ error: `an app with key "${key}" already exists` }, { status: 409 })
  }

  const inserted = (await db.execute(sql`
    insert into form_templates (org_id, key, name, category, description, status, kind, created_by, updated_by)
    values (${user.orgId}, ${key}, ${name}, ${body.category?.trim() || null},
            ${body.description?.trim() || null}, 'draft', ${kind}, ${user.id}, ${user.id})
    returning id
  `)) as any
  const templateId = inserted.rows[0].id as string

  await db.execute(sql`
    insert into form_template_versions (org_id, template_id, version, schema, created_by, updated_by)
    values (${user.orgId}, ${templateId}, 1,
            ${JSON.stringify(emptyFormSchema(name))}::jsonb, ${user.id}, ${user.id})
  `)

  return NextResponse.json({ id: templateId, key }, { status: 201 })
}
