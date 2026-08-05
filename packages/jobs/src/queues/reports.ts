import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from '../connection'

export const REPORTS_QUEUE = 'reports'

/**
 * One scheduled report run: render the definition's PDF and email it to the
 * schedule's recipients. `scheduleId` is present for scheduled runs, absent for
 * ad-hoc "run now" deliveries.
 */
export type ReportJobData = {
  /** Durable database outbox row. Scheduled jobs always carry this id. */
  runId: string
  orgId: string
  definitionId: string
  scheduleId?: string
  recipients?: string[]
  /** Extra query params for the render (period preset override, side, etc.). */
  params?: Record<string, string>
}

let reportsQueue: Queue<ReportJobData> | undefined

export function getReportsQueue(): Queue<ReportJobData> {
  reportsQueue ??= new Queue<ReportJobData>(REPORTS_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return reportsQueue
}

export async function enqueueReportRun(data: ReportJobData, options?: JobsOptions) {
  return getReportsQueue().add('run', data, options)
}
