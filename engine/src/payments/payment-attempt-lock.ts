import { sql } from "drizzle-orm";
import { db, pinnedTransactionExecutor } from "../platform/db.ts";

/** Provider delivery and return decisions acquire this fence before subject or attempt rows. */
export async function lockPaymentAttempt(orgId: string, attemptId: string): Promise<void> {
  if (!pinnedTransactionExecutor())
    throw new Error("Payment attempt locking requires its native transaction.");
  const identity = JSON.stringify(["openbooks:payment-attempt", orgId, attemptId]);
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity},0))`);
}
