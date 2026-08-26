import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  computeScheduledScriptNextRunAt,
  InvalidScheduledScriptCronError,
  INVALID_SCHEDULED_SCRIPT_CRON_CODE,
  runBulkScript,
  runScheduledScript,
} from '@openbooks/engine/src/scripting.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'

export const runtime = 'nodejs'

function invalidCronResponse(error: InvalidScheduledScriptCronError): NextResponse {
  return NextResponse.json(
    { error: error.message, code: INVALID_SCHEDULED_SCRIPT_CRON_CODE, field: 'cron' },
    { status: 422 },
  )
}

/**
 * POST — manual "Run now".
 *   scheduled: run immediately, then advance the cron schedule.
 *   bulk:      hand to the worker via the scripts queue (durable, 30 s budget);
 *              when Redis is down the run happens inline as a fallback.
 * The authenticated caller is attributed on every path — queued via
 * ScriptJobData.actorId, inline via opts.actorId — and the runner re-resolves
 * it into script_runs.created_by and any journal actor. This route never runs
 * unattributed: without an actor its material operations would be
 * indistinguishable from system automation.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params

  const existing = (await db.execute<{ trigger_point: string; cron: string | null }>(sql`
    select trigger_point, cron from user_scripts where id = ${id} and org_id = ${user.orgId}
  `))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const kind = existing.rows[0].trigger_point

  try {
    if (kind === 'bulk') {
      try {
        const { enqueueScriptRun } = await import('@openbooks/jobs')
        const job = await enqueueScriptRun({ orgId: user.orgId, scriptId: id, kind: 'bulk', actorId: user.id })
        return NextResponse.json({ queued: true, jobId: job.id })
      } catch {
        // Redis unavailable — run inline so "Run now" still works in dev,
        // under the same authenticated actor as the queued path.
        const outcome = await runBulkScript(id, user.orgId, { actorId: user.id })
        return NextResponse.json({ queued: false, ...outcome })
      }
    }

    // Parse before the execution boundary: an invalid legacy schedule returns
    // a repairable client error without running source or mutating its cursor.
    let next: Date | null = null
    if (kind === 'scheduled') {
      try {
        next = computeScheduledScriptNextRunAt(existing.rows[0].cron)
      } catch (error) {
        if (!(error instanceof InvalidScheduledScriptCronError)) throw error
        return invalidCronResponse(error)
      }
    }

    const outcome = await runScheduledScript(id, user.orgId, { actorId: user.id })
    // Advance next_run_at for scheduled scripts
    if (next) {
      await db.execute(sql`update user_scripts set next_run_at = ${next} where id = ${id} and org_id = ${user.orgId}`)
    }
    return NextResponse.json(outcome)
  } catch (e) {
    if (e instanceof InvalidScheduledScriptCronError) return invalidCronResponse(e)
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
