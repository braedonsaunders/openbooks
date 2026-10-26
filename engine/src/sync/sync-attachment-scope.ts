import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/** Longest an incremental mirror relies on change detection alone before it
 * re-inventories every imported transaction's files. */
export const ATTACHMENT_FULL_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Selects changed attachments for an incremental run or requests a full sweep. */
export function attachmentChangesScope(input: {
  kind: string;
  since: Date | null;
  lastFullSweepAt: Date | null;
  now: Date;
  pulledRefs: readonly string[];
}): { since: Date; sourceRefs: string[] } | null {
  if (input.kind !== "incremental" || !input.since || !input.lastFullSweepAt) return null;
  if (input.now.getTime() - input.lastFullSweepAt.getTime() > ATTACHMENT_FULL_SWEEP_INTERVAL_MS)
    return null;
  // A sweep that finished before the watermark cannot vouch for files attached
  // between them, so change detection starts at the earlier of the two.
  const since = input.lastFullSweepAt < input.since ? input.lastFullSweepAt : input.since;
  return { since, sourceRefs: [...new Set(input.pulledRefs.map(String))] };
}

export async function lastFullAttachmentSweepAt(
  orgId: string,
  connectionId: string,
): Promise<Date | null> {
  const row = (
    await db.execute<{ at: string | Date | null }>(
      sql`
    select max(finished_at) as at
      from sync_runs
     where org_id = ${orgId} and connection_id = ${connectionId}
       and ((status in ('ok','failed') and kind in ('incremental', 'full_migration')
             and stats->'attachments'->>'scope' = 'all' and stats->'attachments'->>'failures' = '0')
         or (status='ok' and kind = 'attachments' and stats->>'scope' = 'all'))
  `,
      "objects",
    )
  )[0];
  return row?.at ? new Date(row.at) : null;
}

/** One-click migration: master data, then every native transaction, verified. */
