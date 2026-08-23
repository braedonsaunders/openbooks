import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { verifyUser, type ResolvedUser } from "./targets.ts";

/**
 * Out-of-office approval delegation (approval_delegations) — date-ranged,
 * self-service, on-behalf-of audited. While a delegation window is active
 * (now between starts_at/ends_at, not revoked) the delegate sees the
 * principal's pending gates in their worklist and may decide them; the
 * decision records decidedBy = the delegate with an on-behalf-of note
 * (gates.ts). Delegation NEVER raises authority: it only extends gates the
 * principal is the direct assignee of — the principal's gate assignment is
 * the grant being borrowed, nothing else (no role inheritance, no admin
 * powers).
 */

export class DelegationError extends Error {}

type DelegationRow = typeof schema.approvalDelegations.$inferSelect;

const ACTIVE = (t: typeof schema.approvalDelegations) =>
  and(
    sql`${t.revokedAt} is null`,
    sql`now() between ${t.startsAt} and ${t.endsAt}`,
  );

/**
 * The principal, when `delegateUserId` currently holds an active delegation
 * from `principalUserId`. Null = no active window (or the principal is no
 * longer an active in-org user — a deactivated principal's delegation is
 * inert, matching how their own gate access would be).
 */
export async function activeDelegationPrincipal(
  orgId: string,
  principalUserId: string,
  delegateUserId: string,
): Promise<ResolvedUser | null> {
  const t = schema.approvalDelegations;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.fromUserId, principalUserId),
        eq(t.toUserId, delegateUserId),
        ACTIVE(t),
      ),
    )
    .limit(1);
  if (rows.length === 0) return null;
  return verifyUser(orgId, principalUserId);
}

/**
 * Principals whose gates the delegate may currently act on (deduped), for the
 * worklist's delegated-gates block.
 */
export async function activeDelegationPrincipals(
  orgId: string,
  delegateUserId: string,
): Promise<ResolvedUser[]> {
  const r = (await db.execute<ResolvedUser>(sql`
    select distinct u.id, u.name, u.email
      from approval_delegations d
      join users u on u.id = d.from_user_id and u.org_id = d.org_id and u.is_active
     where d.org_id = ${orgId} and d.to_user_id = ${delegateUserId}
       and d.revoked_at is null and now() between d.starts_at and d.ends_at
  `));
  return r.rows;
}

export interface DelegationView {
  id: string;
  fromUserId: string;
  fromUserName: string | null;
  toUserId: string;
  toUserName: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
  /** 'active' | 'upcoming' as of now. */
  phase: "active" | "upcoming";
  direction: "given" | "received";
}

/** My active + upcoming (not revoked, not ended) delegations, both directions. */
export async function listUserDelegations(orgId: string, userId: string): Promise<DelegationView[]> {
  const r = (await db.execute<Record<string, unknown>>(sql`
    select d.id, d.from_user_id as "fromUserId", fu.name as "fromUserName",
           d.to_user_id as "toUserId", tu.name as "toUserName",
           d.starts_at as "startsAt", d.ends_at as "endsAt", d.reason,
           (now() >= d.starts_at) as "isActive"
      from approval_delegations d
      left join users fu on fu.id = d.from_user_id
      left join users tu on tu.id = d.to_user_id
     where d.org_id = ${orgId}
       and (d.from_user_id = ${userId} or d.to_user_id = ${userId})
       and d.revoked_at is null and d.ends_at >= now()
     order by d.starts_at
  `));
  return r.rows.map((row) => ({
    id: String(row.id),
    fromUserId: String(row.fromUserId),
    fromUserName: (row.fromUserName as string | null) ?? null,
    toUserId: String(row.toUserId),
    toUserName: (row.toUserName as string | null) ?? null,
    startsAt: row.startsAt as Date,
    endsAt: row.endsAt as Date,
    reason: (row.reason as string | null) ?? null,
    phase: row.isActive ? "active" : "upcoming",
    direction: String(row.fromUserId) === userId ? "given" : "received",
  }));
}

/**
 * Self-service delegation create: `fromUserId` (the caller) hands their gates
 * to `toUserId` for [startsAt, endsAt]. Overlapping windows are ALLOWED (two
 * simultaneous delegates both see the gates — quorum semantics are unchanged
 * since only the principal's row exists); the result flags the overlap so the
 * caller can surface it.
 */
export async function createDelegation(args: {
  orgId: string;
  fromUserId: string;
  toUserId: string;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}): Promise<{ delegation: DelegationRow; overlapping: boolean }> {
  const { orgId, fromUserId, toUserId, startsAt, endsAt } = args;
  if (fromUserId === toUserId) {
    throw new DelegationError("you cannot delegate approvals to yourself");
  }
  if (!(endsAt.getTime() > startsAt.getTime())) {
    throw new DelegationError("the delegation end must be after its start");
  }
  // Bound the window so a standing self-delegation can't silently persist for
  // years (governance): out-of-office coverage is measured in days/weeks.
  const MAX_DELEGATION_MS = 366 * 24 * 3_600_000;
  if (endsAt.getTime() - startsAt.getTime() > MAX_DELEGATION_MS) {
    throw new DelegationError("a delegation may not span more than one year");
  }
  const to = await verifyUser(orgId, toUserId);
  if (!to) throw new DelegationError("delegate target is not an active user in this org");

  const t = schema.approvalDelegations;
  const overlap = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.fromUserId, fromUserId),
        sql`${t.revokedAt} is null`,
        sql`${t.startsAt} < ${endsAt}`,
        sql`${t.endsAt} > ${startsAt}`,
      ),
    )
    .limit(1);

  const delegation = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(t)
      .values({
        orgId,
        fromUserId,
        toUserId,
        startsAt,
        endsAt,
        reason: args.reason?.trim() || null,
        createdBy: fromUserId,
      })
      .returning();
    // Append-only audit trail for the grant of approval authority: who
    // delegated to whom, over which window (the row carries no amount limit —
    // delegation never raises authority, so there is none to record).
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'approval_delegations', ${row.id}, 'insert',
              ${JSON.stringify({ after: row })}::jsonb, ${fromUserId})
    `);
    return row;
  });
  return { delegation, overlapping: overlap.length > 0 };
}

/** Revoke one of MY delegations (only the principal may revoke their own). */
export async function revokeDelegation(orgId: string, id: string, userId: string): Promise<void> {
  const t = schema.approvalDelegations;
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(t)
      .where(and(eq(t.id, id), eq(t.orgId, orgId)));
    const updated = await tx
      .update(t)
      .set({ revokedAt: new Date(), updatedBy: userId, updatedAt: new Date() })
      .where(
        and(
          eq(t.id, id),
          eq(t.orgId, orgId),
          eq(t.fromUserId, userId),
          sql`${t.revokedAt} is null`,
          gte(t.endsAt, new Date()),
        ),
      )
      .returning();
    if (updated.length === 0) {
      // Disambiguate for a friendlier 404 vs 409.
      if (!before || before.fromUserId !== userId)
        throw new DelegationError("delegation not found");
      throw new DelegationError("this delegation is already revoked or expired");
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'approval_delegations', ${id}, 'update',
              ${JSON.stringify({
                field: "revokedAt",
                before: before ?? null,
                after: updated[0],
              })}::jsonb, ${userId})
    `);
  });
}
