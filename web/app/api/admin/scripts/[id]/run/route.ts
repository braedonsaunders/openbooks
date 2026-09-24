import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  computeScheduledScriptNextRunAt,
  InvalidScheduledScriptCronError,
  INVALID_SCHEDULED_SCRIPT_CRON_CODE,
  runBulkScript,
  runScheduledScript,
} from '@openbooks/engine/src/scripting/scripting.ts'
import {
  bulkRunClientKey,
  bulkScriptQueueJobId,
  claimBulkRunKey,
  completeBulkRunKey,
} from '@openbooks/engine/src/scripting/bulk-run-claim.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { unexpectedServerError } from '../../../../../../lib/api/unexpected'
import { isUuid } from '../../../../../../lib/list-params'

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
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('scripts.manage', 'scripts')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  // A malformed id names no script: same answer as an unknown one, never a
  // PostgreSQL uuid cast error escaping as a 500.
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const existing = (await db.execute<{ trigger_point: string; cron: string | null; is_active: boolean; cursor: string | null }>(sql`
    select trigger_point, cron, is_active, next_run_at::text as cursor from user_scripts where id = ${id} and org_id = ${user.orgId}
  `))
  if (!existing.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const kind = existing.rows[0].trigger_point
  if (!existing.rows[0].is_active) return NextResponse.json({ error: 'Activate this script before running it.', code: 'SCRIPT_INACTIVE' }, { status: 409 })
  if (kind !== 'scheduled' && kind !== 'bulk') return NextResponse.json({ error: 'Run now is available only for scheduled and bulk scripts.', code: 'SCRIPT_TRIGGER_NOT_RUNNABLE' }, { status: 422 })

  try {
    if (kind === 'bulk') {
      // E02: a bulk Run-now is a non-idempotent money-moving execution, so
      // it carries the caller's run key plus a durable claim. A double-click
      // reuses the key: the second request either replays the recorded
      // outcome (completed) or is refused as in-flight (409) — it never runs
      // twice. Without a client key each request mints a fresh one (no
      // cross-request dedupe). The queue id is deterministic in the key, so
      // live duplicates collapse in BullMQ; the worker re-checks the claim
      // because BullMQ dedupe only covers live jobs.
      let rawBody: unknown = null
      try {
        rawBody = await req.json()
      } catch {
        rawBody = null
      }
      const provided = (rawBody as { idempotencyKey?: unknown } | null)?.idempotencyKey
      let runKey: string
      try {
        runKey = bulkRunClientKey(provided)
      } catch {
        return NextResponse.json(
          { error: 'A valid idempotencyKey is required; retry this run with the same client key.', code: 'SCRIPT_RUN_KEY_INVALID' },
          { status: 400 },
        )
      }
      const claim = await claimBulkRunKey({ orgId: user.orgId, actorId: user.id, scriptId: id, key: runKey })
      if (claim.status === 'completed') {
        return NextResponse.json({ ...(claim.response as Record<string, unknown>), deduped: true })
      }
      if (claim.status === 'inflight') {
        return NextResponse.json(
          { error: 'A run with this key is already in progress.', code: 'SCRIPT_RUN_IN_PROGRESS' },
          { status: 409 },
        )
      }
      if (claim.status === 'mismatched') {
        return NextResponse.json(
          { error: 'This run key is already in use by a different script.', code: 'SCRIPT_RUN_KEY_MISMATCH' },
          { status: 409 },
        )
      }
      const queueJobId = bulkScriptQueueJobId(id, runKey)
      const payload = { orgId: user.orgId, scriptId: id, kind: 'bulk' as const, actorId: user.id, idempotencyKey: runKey }
      try {
        const { enqueueScriptRun } = await import('@openbooks/jobs')
        const job = await enqueueScriptRun(payload, { jobId: queueJobId })
        return NextResponse.json({ queued: true, jobId: job.id, idempotencyKey: runKey })
      } catch {
        // The enqueue reply may be lost after Redis accepted the job: only
        // run inline on provable non-acceptance, mirroring the report and
        // close delivery settlement. A kept job proceeds down the normal
        // queued path; the worker completes the claim.
        let accepted = false
        try {
          const { getScriptsQueue } = await import('@openbooks/jobs')
          accepted = (await getScriptsQueue().getJob(queueJobId)) != null
        } catch {
          accepted = false
        }
        if (accepted) return NextResponse.json({ queued: true, jobId: queueJobId, idempotencyKey: runKey })
        // Redis unavailable — run inline so "Run now" still works in dev,
        // under the same authenticated actor as the queued path, completing
        // the same claim the worker would have completed.
        const outcome = await runBulkScript(id, user.orgId, { actorId: user.id })
        const response = { queued: false, ...outcome }
        await completeBulkRunKey({ orgId: user.orgId, actorId: user.id, scriptId: id, key: runKey, response })
        return NextResponse.json(response)
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
    // Source runs outside a transaction. Advance only the captured scheduling
    // policy/cursor; a concurrent editor or scheduler tick owns its new value.
    if (next) {
      await db.execute(sql`update user_scripts set next_run_at = ${next}
        where id = ${id} and org_id = ${user.orgId} and trigger_point = 'scheduled' and is_active
          and cron is not distinct from ${existing.rows[0].cron}
          and next_run_at is not distinct from ${existing.rows[0].cursor}::timestamptz`)
    }
    return NextResponse.json(outcome)
  } catch (e) {
    if (e instanceof InvalidScheduledScriptCronError) return invalidCronResponse(e)
    return unexpectedServerError('admin/scripts/run', e)
  }
}
