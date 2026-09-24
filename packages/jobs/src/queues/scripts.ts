import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from '../connection'

export const SCRIPTS_QUEUE = 'scripts'

/**
 * One background script run. Two kinds share the queue:
 *   scheduled — a cron'd user script claimed by the in-app scheduler and
 *               handed to the worker (falls back inline when Redis is down)
 *   bulk      — a long-budget "Run now" job (extended timeout + row limits)
 */
export type ScriptJobData = {
  orgId: string
  scriptId: string
  kind: 'scheduled' | 'bulk'
  /** Who pressed Run now (absent for cron ticks). */
  actorId?: string
  /**
   * The caller's run key for interactive bulk runs (E02). The worker
   * re-checks the durable claim under this key because BullMQ dedupe only
   * covers live jobs: a redelivered duplicate reconciles onto the recorded
   * outcome instead of executing the script twice. Absent on scheduled runs
   * (occurrence keys) and on jobs enqueued before the key existed.
   */
  idempotencyKey?: string
  /**
   * Immutable occurrence identity for scheduled runs (the scheduler's
   * occurrence key: script + scheduled fire time). The worker forwards it
   * as the run's journal idempotency scope, so a recovery retry of the same
   * occurrence replays instead of double-posting. Absent on bulk runs and
   * on jobs enqueued before the key existed.
   */
  occurrenceKey?: string
  /**
   * The scheduler's dispatch-ledger row id for this occurrence. The worker
   * stamps it on its own script_runs row so recovery matches evidence
   * one-to-one by identity, never by timestamp.
   */
  occurrenceRunId?: string
}

let scriptsQueue: Queue<ScriptJobData> | undefined

export function getScriptsQueue(): Queue<ScriptJobData> {
  scriptsQueue ??= new Queue<ScriptJobData>(SCRIPTS_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 1, // scripts are not idempotent by contract — never auto-retry
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return scriptsQueue
}

export async function enqueueScriptRun(data: ScriptJobData, options?: JobsOptions) {
  return getScriptsQueue().add(data.kind, data, options)
}
