import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../../lib/authz'

export const runtime = 'nodejs'

/** Download the stored CSV artifact of a recorded run, scoped to the org. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params

  const r = (await db.execute(sql`
    select run.result_csv, run.status, def.slug
      from report_runs run
      join report_definitions def on def.id = run.definition_id
     where run.id = ${id} and run.org_id = ${user.orgId}
  `)) as unknown as { rows: { result_csv: string | null; status: string; slug: string }[] }
  const row = r.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (row.status !== 'succeeded' || row.result_csv == null) {
    return NextResponse.json({ error: 'no result available for this run' }, { status: 409 })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(row.result_csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${row.slug}-${stamp}.csv"`,
    },
  })
}
