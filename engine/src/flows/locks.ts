import { and, eq } from "drizzle-orm";
import { db, schema } from "../db.ts";

/**
 * Flow-managed record locks — the runtime side of the `lock_record` /
 * `unlock_record` actions (source platform "Lock Record" with role exemptions).
 * Guards call `checkFlowLock` at their edit/void/delete chokepoints; the
 * executor writes rows via `lockRecord`/`unlockRecord`.
 *
 * Exemption model: admins are ALWAYS exempt (someone must be able to fix a
 * mis-locked record), plus any caller holding one of the lock's exemptRoles.
 * This mirrors the replicated source platform payment lock ("except Administrator +
 * customrole1734" → admin + controller).
 */

export interface FlowLockInfo {
  reason: string | null;
  exemptRoles: string[];
  flowId: string;
}

/** The active lock on a record, or null. */
export async function getFlowLock(
  subjectKind: string,
  subjectId: string,
): Promise<FlowLockInfo | null> {
  const [row] = await db
    .select({
      reason: schema.flowLocks.reason,
      exemptRoles: schema.flowLocks.exemptRoles,
      flowId: schema.flowLocks.flowId,
    })
    .from(schema.flowLocks)
    .where(
      and(eq(schema.flowLocks.subjectKind, subjectKind), eq(schema.flowLocks.subjectId, subjectId)),
    );
  return row ?? null;
}

/**
 * Is the record locked FOR THIS CALLER? Returns the lock when it applies —
 * callers turn that into a 409/error — or null when unlocked/exempt.
 * `callerRoles` are the caller's role keys; pass `isAdmin` from the authz
 * layer (web) or a role check (engine).
 */
export async function checkFlowLock(
  subjectKind: string,
  subjectId: string,
  caller: { isAdmin: boolean; roles: readonly string[] },
): Promise<FlowLockInfo | null> {
  const lock = await getFlowLock(subjectKind, subjectId);
  if (!lock) return null;
  if (caller.isAdmin) return null;
  if (caller.roles.some((r) => lock.exemptRoles.includes(r))) return null;
  return lock;
}

/** Upsert the record's lock (a second lock_record replaces reason/exemptions). */
export async function lockRecord(args: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
  flowId: string;
  reason?: string | null;
  exemptRoles?: string[];
  userId?: string | null;
}): Promise<void> {
  await db
    .insert(schema.flowLocks)
    .values({
      orgId: args.orgId,
      subjectKind: args.subjectKind,
      subjectId: args.subjectId,
      flowId: args.flowId,
      reason: args.reason ?? null,
      exemptRoles: args.exemptRoles ?? [],
      createdBy: args.userId ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.flowLocks.subjectKind, schema.flowLocks.subjectId],
      set: {
        flowId: args.flowId,
        reason: args.reason ?? null,
        exemptRoles: args.exemptRoles ?? [],
        updatedAt: new Date(),
        updatedBy: args.userId ?? null,
      },
    });
}

export async function unlockRecord(subjectKind: string, subjectId: string): Promise<void> {
  await db
    .delete(schema.flowLocks)
    .where(
      and(eq(schema.flowLocks.subjectKind, subjectKind), eq(schema.flowLocks.subjectId, subjectId)),
    );
}
