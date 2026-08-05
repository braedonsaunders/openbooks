import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'
const FORMATS = new Set(['auto', 'ofx', 'csv', 'camt053', 'bai2', 'mt940'])

/** List import schedules (with server + account names) for the org. */
export async function GET() {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select sc.id, sc.sftp_server_id, sc.account_id, sc.format, sc.folder, sc.is_active, sc.last_run_at, sc.last_result,
           sv.name as server_name, a.number as account_number, a.name as account_name
      from sftp_import_schedules sc
      join sftp_servers sv on sv.id = sc.sftp_server_id
      join accounts a on a.id = sc.account_id
     where sc.org_id = ${gate.user.orgId} order by sc.created_at desc
  `)) as unknown as { rows: unknown[] }
  return NextResponse.json({ schedules: r.rows })
}

/** Create an import schedule. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const body = (await req.json().catch(() => ({}))) as { sftpServerId?: string; accountId?: string; format?: string; folder?: string; csvMapping?: unknown }
  if (!body.sftpServerId || !isUuid(body.sftpServerId) || !body.accountId || !isUuid(body.accountId)) {
    return NextResponse.json({ error: 'sftpServerId and accountId are required' }, { status: 400 })
  }
  const format = FORMATS.has(String(body.format)) ? body.format : 'auto'
  const folder = (String(body.folder ?? 'inbound').trim() || 'inbound').replace(/^\/+|\/+$/g, '')
  const r = (await db.execute(sql`
    insert into sftp_import_schedules (org_id, sftp_server_id, account_id, format, folder, csv_mapping, created_by)
    values (${user.orgId}, ${body.sftpServerId}, ${body.accountId}, ${format}, ${folder},
            ${body.csvMapping ? JSON.stringify(body.csvMapping) : null}::jsonb, ${user.id})
    returning id
  `)) as unknown as { rows: { id: string }[] }
  return NextResponse.json({ id: r.rows[0]!.id })
}
