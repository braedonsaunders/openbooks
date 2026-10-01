import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Hold before any subject row or run lock. Different policies can govern the
 * same record, so their final decisions and cancellation must reconcile against
 * one committed subject state. The lock lasts for the caller's transaction.
 */
export async function lockFlowSubjectDecision(
  orgId: string,
  subjectKind: string,
  subjectId: string,
): Promise<void> {
  const identity = JSON.stringify([
    "openbooks:flow-subject-decision",
    orgId,
    subjectKind,
    subjectId,
  ]);
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
  );
}
