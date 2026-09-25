import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  apCaptureReprocessJobId,
  apCaptureUploadJobId,
  enqueueApCapture,
  getApCaptureQueue,
} from "@openbooks/jobs";

/**
 * Dispatch-recovery scan for AP capture (I5-platform-35).
 *
 * Upload and reprocess commit `status = 'queued'` in a database transaction
 * and enqueue the BullMQ job afterwards. A process crash (or lost
 * connectivity) between the two leaves a row that is queued forever: the
 * worker only sees BullMQ jobs, and the enqueue-failure catch cannot run
 * when the process is dead. This duty re-drives every stale queued row
 * whose deterministic job id has no job at all, with the same payload shape
 * the routes enqueue (the worker re-derives subsidiary scope from the actor
 * when the recovered payload omits it).
 *
 * Idempotency rests on the deterministic job ids: a job created concurrently
 * (slow route, racing tick) is found by getJob and skipped, and a
 * re-enqueue of an already-existing id dedupes in BullMQ instead of
 * extracting twice. Rows whose id resolves to a retained completed/failed
 * job are NOT re-driven here — that row ran and its outcome belongs to the
 * claim-recovery path, not this scan — they are logged for operators (the
 * manual reprocess route mints a fresh generation for them).
 */
const DISPATCH_GRACE_MINUTES = 10;
const DISPATCH_BATCH_LIMIT = 100;

export interface CaptureDispatchSummary {
  candidates: number;
  redispatched: number;
  skippedDispatched: number;
}

export async function recoverUnenqueuedApCaptures(
  limit: number = DISPATCH_BATCH_LIMIT,
): Promise<CaptureDispatchSummary> {
  const summary: CaptureDispatchSummary = { candidates: 0, redispatched: 0, skippedDispatched: 0 };
  await withBypassContext(async () => {
    const stale = (
      await db.execute<{
        id: string;
        org_id: string;
        updated_by: string | null;
        attempts: number;
      }>(sql`
        select id, org_id, updated_by, attempts from ap_capture_items
         where status = 'queued'
           and updated_at < now() - make_interval(mins => ${DISPATCH_GRACE_MINUTES})
         order by updated_at
         limit ${limit}
      `)
    ).rows;
    summary.candidates = stale.length;
    if (stale.length === 0) return;
    const queue = getApCaptureQueue();
    for (const row of stale) {
      const jobId =
        row.attempts === 0 ? apCaptureUploadJobId(row.id) : apCaptureReprocessJobId(row.id, row.attempts);
      const existing = await queue.getJob(jobId);
      if (existing) {
        summary.skippedDispatched += 1;
        console.warn(
          `[ap-capture-dispatch] item ${row.id} is queued with job ${jobId} in state ${await existing
            .getState()
            .catch(() => "unknown")}; leaving it for the claim path (reprocess manually for a fresh generation)`,
        );
        continue;
      }
      await enqueueApCapture(
        {
          orgId: row.org_id,
          captureItemId: row.id,
          ...(row.updated_by ? { actorId: row.updated_by } : {}),
        },
        { jobId },
      );
      await db.execute(sql`
        insert into ap_capture_events (org_id, capture_item_id, event_kind, detail, actor_id)
        values (${row.org_id}, ${row.id}, 'dispatch_recovered',
                ${JSON.stringify({ jobId })}::jsonb, ${row.updated_by})
      `);
      summary.redispatched += 1;
    }
  });
  return summary;
}
