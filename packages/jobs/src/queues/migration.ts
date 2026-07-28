import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from '../connection'

export const MIGRATION_QUEUE = 'migration'

/**
 * One external-system migration/mirror/attachment pass for a tenant connection.
 *   full_migration — master data + entire GL history, verified (the one click).
 *   preflight      — read-only full-population document and ledger comparison.
 *   mirror         — incremental catch-up from the connection's cursor.
 *   project_financials — full source billing-state reconciliation only.
 *   attachments    — source-file inventory and idempotent object-storage import.
 *   targeted_repair — bounded source-document rematerialization (operator/API).
 * The heavy lifting runs on the worker so an 8-year backfill isn't hostage to
 * an HTTP request timeout.
 */
export type MigrationJobData = {
  orgId: string
  connectionId: string
  mode: 'full_migration' | 'preflight' | 'mirror' | 'project_financials' | 'attachments' | 'targeted_repair'
  triggeredBy?: string
  /** Operationally retry only these upstream file identities. The worker
   * accepts this scope solely for attachment jobs; ordinary UI-triggered
   * attachment syncs omit it and retain full reconciliation semantics. */
  sourceFileIds?: string[]
  /** Exact upstream transaction identities for a bounded source repair. */
  sourceRefs?: string[]
}

let migrationQueue: Queue<MigrationJobData> | undefined

export function getMigrationQueue(): Queue<MigrationJobData> {
  migrationQueue ??= new Queue<MigrationJobData>(MIGRATION_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      // Migrations are long and idempotent; retry once, keep history a while.
      attempts: 2,
      backoff: { type: 'exponential', delay: 120_000 },
      removeOnComplete: { age: 30 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return migrationQueue
}

export async function enqueueMigration(data: MigrationJobData, options?: JobsOptions) {
  return getMigrationQueue().add(data.mode, data, options)
}
