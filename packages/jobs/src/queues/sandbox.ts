import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from '../connection'

export const SANDBOX_QUEUE = 'sandbox'

/**
 * One sandbox lifecycle operation, run asynchronously so a create/refresh that
 * copies a large tenant doesn't block the request. `op` selects the action;
 * `sandboxId` is present for refresh/reset/delete, absent for create (which
 * carries the create payload).
 */
export type SandboxJobData =
  | {
      op: 'create'
      productionOrgId: string
      name: string
      tier: 'dev' | 'masked' | 'full' | 'as_of'
      masked: boolean
      asOfPeriodId?: string | null
      createdBy?: string | null
    }
  | { op: 'refresh'; sandboxId: string; keepCustomizations: boolean }
  | { op: 'reset'; sandboxId: string }
  | { op: 'delete'; sandboxId: string }

let sandboxQueue: Queue<SandboxJobData> | undefined

export function getSandboxQueue(): Queue<SandboxJobData> {
  sandboxQueue ??= new Queue<SandboxJobData>(SANDBOX_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      // Clone/refresh are not safe to blindly retry (partial state); surface
      // failure via the sandbox row's status instead.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return sandboxQueue
}

export async function enqueueSandboxOp(data: SandboxJobData, options?: JobsOptions) {
  return getSandboxQueue().add(data.op, data, options)
}
