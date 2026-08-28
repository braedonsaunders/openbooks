import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { can, guardPermission } from '../../../../lib/authz'
import { getResource } from '../../../../lib/data-io/resources'
import { toCsv, toJson, toXlsx } from '../../../../lib/data-io/serialize'
import { csvResponse, safeName, xlsxResponse } from '../../../../lib/export'
import { EXPORT_FORMATS, type ExportFormat } from '../../../../lib/data-io/types'

export const runtime = 'nodejs'

/**
 * Generic export: any registered resource → CSV / XLSX / JSON. The resource
 * key selects a DataResource (Setup entity, master-data table, or custom
 * record type); its own read permission is enforced on top of data.export.
 * Reference columns are emitted as human natural keys, not UUIDs.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('data.export')
  if (gate instanceof NextResponse) return gate
  const authz = gate

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    resource?: string
    columns?: string[]
    format?: ExportFormat
  }
  const resourceKey = String(body.resource ?? '')
  const format: ExportFormat = EXPORT_FORMATS.includes(body.format as ExportFormat)
    ? (body.format as ExportFormat)
    : 'csv'

  // Bind the role-derived subsidiary fence before any resource read. The
  // generic registry otherwise defaults to an org-only adapter, which would
  // let a restricted AP/AR/GL reader export another subsidiary's documents.
  const resource = await getResource(authz.user.orgId, resourceKey, authz.allowedSubsidiaryIds)
  if (!resource) return NextResponse.json({ error: 'unknown resource' }, { status: 404 })
  if (!can(authz, resource.descriptor.readPermission)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { columns, rows } = await resource.read({
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  })
  const selected =
    Array.isArray(body.columns) && body.columns.length > 0
      ? columns.filter((c) => body.columns!.includes(c.key))
      : columns
  const cols = selected.length > 0 ? selected : columns

  const title = safeName(resource.descriptor.label || resource.descriptor.key)
  const stamp = await businessToday(authz.user.orgId)
  const filename = `${title}-${stamp}`

  if (format === 'csv') return csvResponse(toCsv(title, cols, rows), filename)
  if (format === 'xlsx') {
    return xlsxResponse(await toXlsx(title, cols, rows, new Date(`${stamp}T00:00:00Z`)), filename)
  }
  // json
  return new NextResponse(new TextEncoder().encode(toJson(cols, rows)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName(filename)}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}
