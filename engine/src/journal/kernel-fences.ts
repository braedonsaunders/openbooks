import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Posting takes no organization row lock: one deadlocked concurrent multi-post flows (40P01).
 * Keyed postings converge on their idempotency index, entry numbers lock per candidate
 * (records/entry-number.ts), and the fences below cover only the state a posting reads.
 */

/**
 * Holds the shared side of the close/posting fence through commit, before the open-period check:
 * a concurrent close either waits behind this posting or the check re-reads its commit.
 */
export async function holdPeriodPostingFence(
  executor: SqlExecutor,
  scope: { orgId: string; periodId: string; bookId: string },
): Promise<void> {
  await executor.execute(
    sql`select period_posting_fence(${scope.orgId}, ${scope.periodId}, ${scope.bookId})`,
  );
}
