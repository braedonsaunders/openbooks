import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { runScheduledScript, computeNextRunAt } from '@openbooks/engine/src/scripting.ts'
import { guardPermission } from '../../../../../../lib/authz'

export const runtime = 'nodejs'

/** POST — run a scheduled script on demand (manual "Run now"). Executes the
 *  script immediately regardless of its next_run_at, then advances the cron
 *  schedule. Returns the script_runs outcome. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('scripts.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute(sql`
    select trigger_point, cron from user_scripts where id = ${id} and org_id = ${user.orgId}
  `)) as unknown as { rows: { trigger_point: string; cron: string | null }[] }
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    const outcome = await runScheduledScript(id, user.orgId)
    // Advance next_run_at for scheduled scripts
    const cron = existing.rows[0].cron
    const next = cron ? computeNextRunAt(cron) : null
    if (next) {
      await db.execute(sql`update user_scripts set next_run_at = ${next} where id = ${id} and org_id = ${user.orgId}`)
    }
    return NextResponse.json(outcome)
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
