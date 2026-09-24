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
  /**
   * Explicit send-now marker: an operator pressed "Send now" for this
   * delivery. The worker honours it regardless of the package's cadence —
   * manual cadence means "only when someone sends it", so a marked job
   * must deliver. Unmarked jobs are cadence-driven and skip manual
   * packages. Only the send-package route sets this; the publish path
   * never does, so scheduled ticks keep skipping manual packages.
   */
  manualTrigger?: boolean
  /** The user who authorized this send; render permission is re-resolved. */
  senderId?: string
  /** Client-minted identity for this manual send intent. */
  idempotencyKey?: string
}


const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertManualScope(input: { packageId: string; periodId?: string; bookId?: string; idempotencyKey?: string }): void {
  for (const [label, value] of [
    ["package", input.packageId],
    ["period", input.periodId ?? ""],
    ["book", input.bookId ?? ""],
    ["idempotency key", input.idempotencyKey ?? ""],
  ] as const) {
    if (!UUID.test(value)) throw new Error(`close manual delivery requires a valid ${label} id`)
  }
}

export function closeDeliveryManualJobId(input: { packageId: string; periodId?: string; bookId?: string; idempotencyKey?: string }): string {
  assertManualScope(input)
  return `close-delivery|manual|${input.packageId}|${input.periodId}|${input.bookId}|${input.idempotencyKey}`
}

export function closeDeliveryManualEmailIntentKey(input: { orgId: string; packageId: string; periodId?: string; bookId?: string; idempotencyKey?: string }): string {
  assertManualScope(input)
  if (!UUID.test(input.orgId)) throw new Error("close manual delivery requires a valid org id")
  return `close-package|manual|${input.orgId}|${input.packageId}|${input.periodId}|${input.bookId}|${input.idempotencyKey}`
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
