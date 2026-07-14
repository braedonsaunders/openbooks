import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../lib/authz'

export const runtime = 'nodejs'

const COLUMNS: Record<string, string> = {
  ar: 'ar_closed_at',
  ap: 'ap_closed_at',
  gl: 'gl_closed_at',
}

export async function POST(req: Request) {
  const gate = await guardPermission('gl.close')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const { periodId, module, action } = (await req.json()) as {
    periodId?: string
    module?: string
    action?: 'close' | 'reopen'
  }
  const column = module ? COLUMNS[module] : undefined
  if (!periodId || !column || !['close', 'reopen'].includes(action ?? '')) {
    return NextResponse.json({ error: 'periodId, module (ar|ap|gl), action (close|reopen) required' }, { status: 400 })
  }

  // GL close requires the subledgers to be closed first; reopening GL is fine.
  if (module === 'gl' && action === 'close') {
    const r = (await db.execute(
      sql`select ar_closed_at, ap_closed_at from accounting_periods where id = ${periodId} and org_id = ${user.orgId}`,
    )) as unknown as { rows: { ar_closed_at: string | null; ap_closed_at: string | null }[] }
    const p = r.rows[0]
    if (!p) return NextResponse.json({ error: 'period not found' }, { status: 404 })
    if (!p.ar_closed_at || !p.ap_closed_at) {
      return NextResponse.json({ error: 'close AR and AP before closing GL' }, { status: 422 })
    }
  }
  // Reopening a subledger while GL is closed makes no sense; reopen GL first.
  if (module !== 'gl' && action === 'reopen') {
    const r = (await db.execute(
      sql`select gl_closed_at from accounting_periods where id = ${periodId} and org_id = ${user.orgId}`,
    )) as unknown as { rows: { gl_closed_at: string | null }[] }
    if (r.rows[0]?.gl_closed_at) {
      return NextResponse.json({ error: 'reopen GL before reopening a subledger' }, { status: 422 })
    }
  }

  await db.execute(sql`
    update accounting_periods
       set ${sql.raw(column)} = ${action === 'close' ? sql`now()` : sql`null`}, updated_at = now()
     where id = ${periodId} and org_id = ${user.orgId}
  `)
  return NextResponse.json({ ok: true })
}
