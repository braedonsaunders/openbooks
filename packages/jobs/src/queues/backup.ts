import { Queue, type JobsOptions } from 'bullmq'
import { getConnection } from '../connection'

export const BACKUP_QUEUE = 'backup'

/**
 * One backup execution, run asynchronously so an export of a large tenant
 * doesn't block the web request that asked for it. `runId` is the backup_runs
 * ledger row (already inserted, status 'queued'); the worker claims and
 * executes it. jobId = runId — a run can only ever be queued once.
 */
export type BackupJobData = {
  op: 'run'
  runId: string
  orgId: string
}

let backupQueue: Queue<BackupJobData> | undefined

export function getBackupQueue(): Queue<BackupJobData> {
  backupQueue ??= new Queue<BackupJobData>(BACKUP_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      // A failed export is not safe to blindly retry mid-flight (partial temp
      // files / object state); failure is surfaced on the run row instead.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return backupQueue
}

export async function enqueueBackupRun(data: BackupJobData, options?: JobsOptions) {
  return getBackupQueue().add(data.op, data, options)
}
