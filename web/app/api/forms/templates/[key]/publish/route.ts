import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { parseFormSchema } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../../lib/authz'
import { getLatestVersion, getTemplateByKey } from '../../../_lib'

export const runtime = 'nodejs'

/**
 * Publish the current draft: re-validate its schema, stamp published_at
 * (making the version row immutable), and flip the template to `published`.
 * Fillers always see the highest published version; older published versions
 * keep their responses readable forever.
 */
export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { key } = await params

  const template = await getTemplateByKey(user.orgId, key)
  if (!template) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { changelog?: string }

  const latest = await getLatestVersion(user.orgId, template.id)
  if (!latest) return NextResponse.json({ error: 'template has no draft' }, { status: 409 })
  if (latest.published_at) {
    return NextResponse.json(
      { error: `version ${latest.version} is already published — edit the form to start a new draft` },
      { status: 409 },
    )
  }

  // A draft can be saved with dangling references mid-edit; publishing is the
  // hard gate. Never let an invalid schema become an immutable version.
  const parsed = parseFormSchema(latest.schema)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'schema has validation issues', issues: parsed.issues },
      { status: 422 },
    )
  }
  const hasField = parsed.data.sections.some((s) => s.fields.length > 0)
  if (!hasField) {
    return NextResponse.json({ error: 'add at least one field before publishing' }, { status: 422 })
  }

  await db.execute(sql`
    update form_template_versions
       set published_at = now(), published_by = ${user.id},
           changelog = ${body.changelog?.trim() || null},
           updated_at = now(), updated_by = ${user.id}
     where id = ${latest.id} and org_id = ${user.orgId}
  `)
  await db.execute(sql`
    update form_templates
       set status = 'published', updated_at = now(), updated_by = ${user.id}
     where id = ${template.id} and org_id = ${user.orgId}
  `)

  return NextResponse.json({ ok: true, version: latest.version })
}
