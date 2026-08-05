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
