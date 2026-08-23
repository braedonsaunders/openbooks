import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { runDueSftpImports } from '@openbooks/engine/src/sftp/import-job.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'

/** Toggle active, or run the schedule now: { action: 'run' } / { isActive }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; isActive?: boolean }
  if (body.action === 'run') {
    // Scoped run: activate-scan just this org's schedules and report this one.
    const owned = (await db.execute(sql`select id from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}`))
    if (!owned.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const runs = await runDueSftpImports(user.orgId, id)
    const mine = runs.find((r) => r.scheduleId === id)
    return NextResponse.json({ ok: true, result: mine ?? { scheduleId: id, filesSeen: 0, imported: 0, duplicates: 0, errors: [] } })
  }
  await db.execute(sql`
    update sftp_import_schedules set is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('admin.setup.manage', 'bankFeeds')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await db.execute(sql`delete from sftp_import_schedules where id = ${id} and org_id = ${user.orgId}`)
  return NextResponse.json({ ok: true })
}
