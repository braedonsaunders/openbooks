import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, guardPermission } from '../../../../lib/authz'
import { getResource } from '../../../../lib/data-io/resources'
import { guessMapping, parseImportFile } from '../../../../lib/data-io/parse'
import { IMPORT_FORMATS, type ImportFormat, type ImportMode } from '../../../../lib/data-io/types'

export const runtime = 'nodejs'

/**
 * Generic import with a mode discriminator (mirrors the bank-import route):
 *   parse   — normalize an uploaded file → headers + rows + a guessed mapping.
 *   preview — dry-run: coerce/validate/resolve every mapped row, classify
 *             insert vs update, collect errors. Writes NOTHING.
 *   commit  — persist via the resource's validated write path, record an
 *             import_jobs history row.
 *
 * data.import gates the route; the resource's own write permission is enforced
 * on top (e.g. importing accounts also needs admin.setup.manage).
 */
export async function POST(req: Request) {
  const gate = await guardPermission('data.import')
  if (gate instanceof NextResponse) return gate
  const authz = gate
  const orgId = authz.user.orgId

  const body = (await req.json().catch(() => ({}))) as {
    mode?: 'parse' | 'preview' | 'commit'
    resource?: string
    format?: ImportFormat
    text?: string
    base64?: string
    rows?: Record<string, unknown>[]
    mapping?: Record<string, string>
    importMode?: ImportMode
    fileName?: string
    post?: boolean
  }
  const mode = body.mode ?? 'parse'
  const format: ImportFormat = IMPORT_FORMATS.includes(body.format as ImportFormat)
    ? (body.format as ImportFormat)
    : 'csv'

  const resource = await getResource(orgId, String(body.resource ?? ''))
  if (!resource) return NextResponse.json({ error: 'unknown resource' }, { status: 404 })
  if (!resource.descriptor.supportsImport) {
    return NextResponse.json({ error: 'resource is read-only' }, { status: 400 })
  }
  if (!can(authz, resource.descriptor.writePermission)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (mode === 'parse') {
    const parsed = await parseImportFile(format, { text: body.text, base64: body.base64 })
    const fields = await resource.fields()
    const mapping = guessMapping(parsed.headers, fields.map((f) => f.key))
    return NextResponse.json({
      headers: parsed.headers,
      rows: parsed.rows,
      sample: parsed.rows.slice(0, 20),
      total: parsed.rows.length,
      fields,
      mapping,
    })
  }

  // preview / commit both need mapped rows.
  const rawRows = Array.isArray(body.rows) ? body.rows : []
  const mapping = body.mapping ?? {}
  const importMode: ImportMode = body.importMode === 'insert' ? 'insert' : 'upsert'
  const mappedRows = rawRows.map((raw) => applyMapping(raw, mapping))

  // Transactions can optionally post to the ledger — gate that on the kind's
  // post permission (on top of data.import + the create permission above).
  let post = false
  if (body.post && resource.descriptor.canPost) {
    if (resource.descriptor.postPermission && !can(authz, resource.descriptor.postPermission)) {
      return NextResponse.json({ error: 'forbidden: posting requires ' + resource.descriptor.postPermission }, { status: 403 })
    }
    post = true
  }

  const ctx = { orgId, actorId: authz.user.id, dryRun: mode === 'preview', post }
  const outcome = await resource.write(mappedRows, importMode, ctx)

  if (mode === 'preview') {
    return NextResponse.json({ outcome, total: mappedRows.length })
  }

  // commit — record history.
  const inserted = (await db.execute(sql`
    insert into import_jobs
      (org_id, resource_key, resource_label, format, file_name, mode, status, mapping,
       total_rows, created_count, updated_count, failed_count, errors, created_by)
    values (${orgId}, ${resource.descriptor.key}, ${resource.descriptor.label}, ${format},
            ${body.fileName ?? null}, ${importMode},
            ${outcome.failed > 0 && outcome.created === 0 && outcome.updated === 0 ? 'failed' : 'committed'},
            ${JSON.stringify(mapping)}::jsonb, ${mappedRows.length},
            ${outcome.created}, ${outcome.updated}, ${outcome.failed},
            ${JSON.stringify(outcome.errors)}::jsonb, ${authz.user.id})
    returning id`)) as { rows: { id: string }[] }

  return NextResponse.json({ outcome, jobId: inserted.rows[0]?.id, total: mappedRows.length })
}

/** Map a raw source row (keyed by file header) onto field-keyed values. */
function applyMapping(raw: Record<string, unknown>, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [source, field] of Object.entries(mapping)) {
    if (!field) continue
    out[field] = raw[source]
  }
  return out
}
