import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { parseIsoDate } from "../platform/civil-date.ts";

/**
 * Organization aging bucket policy: the ascending day boundaries that turn
 * days-past-due into bucket indexes.
 *
 * One ladder, read everywhere. The AR/AP aging report and the cash cockpits
 * previously each carried the 30/60/90 ladder inline (`web/lib/aging-basis.ts`
 * documents the current behaviour); a boundary change in one screen that the
 * other could not see is how an invoice sits in "current" on one page and
 * "90+" on another. This resolver is the single derivation: the row with the
 * latest effective_from on or before a date governs that date, and with no
 * policy configured the declared default below applies — the buckets the
 * product has always rendered, stated once instead of re-typed per surface.
 */

/** Bucket ladder used while an organization configures no policy of its own. */
export const DEFAULT_AGING_BOUNDARIES: readonly number[] = [30, 60, 90];

export interface AgingBucketPolicy {
  /** Strictly ascending day boundaries. Current is always index 0. */
  boundaries: readonly number[];
  /** Whether the ladder came from a configured policy or the declared default. */
  source: "policy" | "default";
  /** The policy version's effective_from; null while the default applies. */
  effectiveFrom: string | null;
}

/**
 * Bucket index for days past the aging basis date under a ladder: 0 is
 * current (at or before due); each boundary closes its bucket, except the
 * final boundary, which OPENS the last bucket. Under the default ladder this
 * is exactly the historical 0 / 1–30 / 31–60 / 61–89 / 90+ split — ninety
 * days past due is already in the final bucket, not the last bounded one.
 */
export function agingBucketIndex(daysPastDue: number, boundaries: readonly number[]): number {
  if (!Number.isFinite(daysPastDue)) {
    throw new RangeError("days past due must be a finite number");
  }
  if (daysPastDue <= 0) return 0;
  for (let index = 0; index < boundaries.length; index += 1) {
    const opensFinalBucket = index === boundaries.length - 1;
    if (opensFinalBucket ? daysPastDue < boundaries[index]! : daysPastDue <= boundaries[index]!) {
      return index + 1;
    }
  }
  return boundaries.length + 1;
}

/** Bucket count under a ladder: current, one per boundary step, final overdue. */
export function agingBucketCount(boundaries: readonly number[]): number {
  return boundaries.length + 2;
}

/** Refusal raised when a stored policy row cannot be read as a ladder. */
export class AgingBucketPolicyUnreadableError extends Error {
  readonly code = "aging_bucket_policy_unreadable";
  constructor(orgId: string, onDate: string) {
    super(
      `The aging bucket policy for organization ${orgId} on ${onDate} cannot be read — review it in Setup → Company → Aging bucket policies`,
    );
    this.name = "AgingBucketPolicyUnreadableError";
  }
}

/**
 * A ladder from a stored row, or null when the row carries no readable
 * ladder. The write path enforces strictly ascending day counts, so a row
 * that fails that shape is corrupt storage, not a policy — it refuses
 * rather than re-bucketing history under a ladder nobody entered.
 */
function storedBoundaries(raw: unknown): readonly number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const boundaries = raw.map(Number);
  if (boundaries.some((day) => !Number.isInteger(day))) return null;
  for (const [index, boundary] of boundaries.entries()) {
    if (boundary < 1 || boundary > 36500 || (index > 0 && boundary <= boundaries[index - 1]!)) return null;
  }
  return boundaries;
}

/** The ladder in force for an organization on a date. Never null: the default applies. */
export async function agingBucketPolicyFor(
  orgId: string,
  onDate: string,
  tx: Pick<typeof db, "execute"> = db,
): Promise<AgingBucketPolicy> {
  parseIsoDate(onDate);
  // The row shape is inline: drizzle's execute constrains its row type to a
  // record, which a named alias does not satisfy.
  const rows = (await tx.execute<{
    boundaries: unknown;
    effective_from: string | Date;
  }>(sql`
    select boundaries, effective_from
      from aging_bucket_policies
     where org_id = ${orgId}
       and is_active
       and effective_from <= ${onDate}::date
       and (effective_to is null or effective_to >= ${onDate}::date)
     order by effective_from desc
     limit 1
  `)).rows;
  const row = rows[0];
  // A configured row that cannot be read refuses by name: falling back to the
  // default here would silently re-bucket history the organization laddered
  // differently. Only the absence of any row resolves the default.
  if (!row) return { boundaries: [...DEFAULT_AGING_BOUNDARIES], source: "default", effectiveFrom: null };
  const boundaries = storedBoundaries(row.boundaries);
  if (!boundaries) throw new AgingBucketPolicyUnreadableError(orgId, onDate);
  const effectiveFrom = row.effective_from instanceof Date
    ? row.effective_from.toISOString().slice(0, 10)
    : String(row.effective_from).slice(0, 10);
  return { boundaries, source: "policy", effectiveFrom };
}
