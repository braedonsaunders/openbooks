import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  CLOSE_MODULES,
  CloseError,
  periodLockBlocksPosting,
  readEffectivePeriodLock,
  type CloseModule,
} from "../periods/period-policy.ts";
import { periodScopeAdvisoryLock } from "../periods/period-locks.ts";

/**
 * Exact effective period-lock state for one period, book and legal entity.
 *
 * This is snapshot information only: it answers what governs the requested
 * entity at read time, through the same effective-lock resolution posting
 * uses. Posting always rechecks atomically under its own fence, so a state
 * observed here never authorizes a later write.
 */
export interface PeriodLockProvenance {
  /** Stored row identity; never derived or fabricated. */
  id: string;
  /** Whether the governing row is the exact entity row or the organization-wide fallback. */
  scope: "entity" | "organization";
  /** Entity the governing row names; null on the organization-wide row. */
  subsidiaryId: string | null;
  state: string;
  reason: string | null;
  reopenExpiresAt: Date | string | null;
  version: number;
}

export interface PeriodModuleLockState {
  module: CloseModule;
  /**
   * Effective state for the requested entity: the governing stored row's
   * state, or "open" derived only when no stored row governs this entity —
   * derived after the period, book and entity were verified to exist.
   */
  state: string;
  /** Current posting eligibility under the public rule (no imported-lock exemption). */
  blocksPosting: boolean;
  /** The stored governing row, or null when no stored row governs. */
  lock: PeriodLockProvenance | null;
  /** Explicit provenance label matching `lock`: a missing row is never dressed as one. */
  provenance: "entity_lock" | "organization_lock" | "no_lock_record";
}

export interface ExactPeriodLockRead {
  periodId: string;
  bookId: string;
  subsidiaryId: string;
  /** One entry per close module, in canonical CLOSE_MODULES order (GL included). */
  modules: PeriodModuleLockState[];
}

function canonicalUuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new CloseError(`${field} must be a valid UUID`);
  return value.toLowerCase();
}

/**
 * Read the effective lock for every close module at one exact
 * period/book/entity scope. The actor's live `close.read` authority and
 * exact entity scope are established inside the read transaction; the
 * period, active book and active non-elimination entity are share-locked so
 * the verified subjects cannot change mid-read. The native period-scope
 * advisory lock (the same key close transitions take) is then held to the
 * end of the transaction, so the per-module states form one coherent
 * snapshot rather than a mix from either side of a concurrent close.
 */
export async function readExactPeriodLocks(args: {
  orgId: string;
  actorId: string;
  periodId: string;
  bookId: string;
  subsidiaryId: string;
}): Promise<ExactPeriodLockRead> {
  const orgId = canonicalUuid(args.orgId, "orgId");
  const actorId = canonicalUuid(args.actorId, "actorId");
  const periodId = canonicalUuid(args.periodId, "periodId");
  const bookId = canonicalUuid(args.bookId, "bookId");
  const subsidiaryId = canonicalUuid(args.subsidiaryId, "subsidiaryId");
  return withOrgTransaction(orgId, async () => {
    await lockActorCommandAuthority(db, orgId, actorId, subsidiaryId, "close.read");

    const period = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounting_periods
       where org_id = ${orgId} and id = ${periodId} for share`,
        "objects",
      )
    )[0];
    if (!period) throw new CloseError("period not found in this organization");
    const book = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounting_books
       where org_id = ${orgId} and id = ${bookId} and is_active for share`,
        "objects",
      )
    )[0];
    if (!book) throw new CloseError("active accounting book not found in this organization");
    const entity = (
      await db.execute<{ is_active: boolean; is_elimination: boolean }>(
        sql`
      select is_active, is_elimination from subsidiaries
       where org_id = ${orgId} and id = ${subsidiaryId} for share`,
        "objects",
      )
    )[0];
    if (!entity || !entity.is_active || entity.is_elimination) {
      throw new CloseError("active legal entity not found in this organization");
    }

    // The same fence close transitions take, held to commit: a concurrent
    // close either completes before this snapshot or waits for it, so the
    // modules below can never straddle a lock transition.
    await periodScopeAdvisoryLock(db, orgId, periodId, bookId);

    const modules: PeriodModuleLockState[] = [];
    for (const module of CLOSE_MODULES) {
      const lock = await readEffectivePeriodLock(db, {
        orgId,
        periodId,
        bookId,
        subsidiaryId,
        module,
      });
      modules.push({
        module,
        state: lock?.state ?? "open",
        blocksPosting: periodLockBlocksPosting(lock, false),
        lock: lock
          ? {
              id: lock.id,
              scope: lock.subsidiaryId === null ? "organization" : "entity",
              subsidiaryId: lock.subsidiaryId,
              state: lock.state,
              reason: lock.reason,
              reopenExpiresAt: lock.reopenExpiresAt,
              version: lock.version,
            }
          : null,
        provenance: !lock
          ? "no_lock_record"
          : lock.subsidiaryId === null
            ? "organization_lock"
            : "entity_lock",
      });
    }
    return { periodId, bookId, subsidiaryId, modules };
  });
}
