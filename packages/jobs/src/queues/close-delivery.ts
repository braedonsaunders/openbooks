import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from '../connection'

export const CLOSE_DELIVERY_QUEUE = 'close-delivery'

/**
 * Deliver a reporting package: render every attached report with its saved
 * override params and email the bundle to the package recipients. Two triggers:
 *   - automatic: `publishCloseRun` enqueues with `runId` once publish commits;
 *   - manual "Send now": enqueues with an explicit `periodId` + `bookId`.
 * The `$close` period token resolves against whichever period context is given.
 */
export type CloseDeliveryJobData = {
  orgId: string
  packageId: string
  runId?: string
  periodId?: string
  bookId?: string
}

let closeDeliveryQueue: Queue<CloseDeliveryJobData> | undefined

export function getCloseDeliveryQueue(): Queue<CloseDeliveryJobData> {
  closeDeliveryQueue ??= new Queue<CloseDeliveryJobData>(CLOSE_DELIVERY_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return closeDeliveryQueue
}

export async function enqueueCloseDelivery(data: CloseDeliveryJobData, options?: JobsOptions) {
  return getCloseDeliveryQueue().add('deliver', data, options)
}
