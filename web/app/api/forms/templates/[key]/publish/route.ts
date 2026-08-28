import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { parseFormSchema } from '@openbooks/forms-core'
import { guardPermission } from '../../../../../../lib/authz'
import { getTemplateByKey } from '../../../_lib'

export const runtime = 'nodejs'

/**
 * Publish the current draft: re-validate its schema, stamp published_at
 * (making the version row immutable), and flip the template to `published`.
 * Fillers always see the highest published version; older published versions
 * keep their responses readable forever.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { key } = await params

  const template = await getTemplateByKey(user.orgId, key)
  if (!template)
    return NextResponse.json({ error: 'not found' }, { status: 404 })

  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as { changelog?: string }

  const outcome = await db.transaction(async (tx) => {
    // Lock the parent first so concurrent publishers cannot both observe the
    // same draft and stamp it published. The row is re-read inside the
    // transaction because the preflight lookup above is not authoritative.
    const lockedTemplate = (await tx.execute(sql`
      select id
        from form_templates
       where id = ${template.id} and org_id = ${user.orgId}
       for update
    `)) as { rows: { id: string }[] }
    if (lockedTemplate.rows.length === 0) return { kind: 'not-found' as const }

    // Lock and recheck the latest version after taking the parent lock. A
    // published version is immutable; only the still-draft latest row may be
    // validated and transitioned by this request.
    const lockedLatest = (await tx.execute(sql`
      select id, version, schema, published_at
        from form_template_versions
       where org_id = ${user.orgId} and template_id = ${template.id}
       order by version desc
       limit 1
       for update
    `)) as {
      rows: {
        id: string
        version: number
        schema: unknown
        published_at: string | null
      }[]
    }
    const latest = lockedLatest.rows[0]
    if (!latest) return { kind: 'no-draft' as const }
    if (latest.published_at)
      return { kind: 'already-published' as const, version: latest.version }

    // A draft can be saved with dangling references mid-edit; publishing is
    // the hard gate. Never let an invalid schema become an immutable version.
    const parsed = parseFormSchema(latest.schema)
    if (!parsed.success) {
      return { kind: 'invalid-schema' as const, issues: parsed.issues }
    }
    const hasField = parsed.data.sections.some((s) => s.fields.length > 0)
    if (!hasField) return { kind: 'no-fields' as const }

    await tx.execute(sql`
      update form_template_versions
         set published_at = now(), published_by = ${user.id},
             changelog = ${body.changelog?.trim() || null},
             updated_at = now(), updated_by = ${user.id}
       where id = ${latest.id} and org_id = ${user.orgId} and published_at is null
    `)
    await tx.execute(sql`
      update form_templates
         set status = 'published', updated_at = now(), updated_by = ${user.id}
       where id = ${template.id} and org_id = ${user.orgId}
    `)

    return { kind: 'published' as const, version: latest.version }
  })

  if (outcome.kind === 'not-found')
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'no-draft')
    return NextResponse.json(
      { error: 'template has no draft' },
      { status: 409 },
    )
  if (outcome.kind === 'already-published') {
    return NextResponse.json(
      {
        error: `version ${outcome.version} is already published — edit the form to start a new draft`,
      },
      { status: 409 },
    )
  }
  if (outcome.kind === 'invalid-schema') {
    return NextResponse.json(
      { error: 'schema has validation issues', issues: outcome.issues },
      { status: 422 },
    )
  }
  if (outcome.kind === 'no-fields') {
    return NextResponse.json(
      { error: 'add at least one field before publishing' },
      { status: 422 },
    )
  }

  return NextResponse.json({ ok: true, version: outcome.version })
}
