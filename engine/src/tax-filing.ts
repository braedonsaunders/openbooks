import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { periodLockBlocksPosting } from "./close.ts";
import { computeTaxReturn, TaxReturnError, type TaxReturnResult } from "./tax-return.ts";

/**
 * Tax filing lifecycle — the governed prepared → filed transition.
 *
 * Preparing (`web/app/api/tax/filings/route.ts`) computes the return live and
 * freezes an immutable snapshot, hashing it into `snapshot_hash`. That hash is
 * the filing's source-ledger fingerprint: it can only be reproduced while the
 * ledger, tax mappings and form configuration still yield the same return.
 *
 * Marking a filing filed certifies the frozen numbers to a government, so the
 * engine owns two fences at the transition (fnd_mt9844xu_b1ncd4):
 *
 *  1. GOVERNANCE — every accounting period the filing window touches must be
 *     closed for the gl and tax modules on the primary book. A closed period
 *     is frozen by the kernel's own write guards, so no further posting can
 *     silently diverge the ledger from the certified return.
 *  2. INTEGRITY — the return is recomputed from the live source ledger inside
 *     the same transaction and hashed through the same snapshot builder the
 *     prepare path used. Any drift — a journal, a posted tax document, a tax
 *     mapping or rate, even a renamed form — changes the hash and the filing
 *     is rejected as stale; the reviewer prepares a new version instead.
 *
 * Both fences must pass before `status` leaves 'prepared'. Zero rows are
 * written on rejection.
 */

export class TaxFilingError extends Error {
  readonly name = "TaxFilingError";
  constructor(
    /** Machine-readable failure the API maps to an HTTP status. */
    readonly code: "not-found" | "already-filed" | "period-not-closed" | "stale",
    message: string,
  ) {
    super(message);
  }
}

export interface TaxFilingSnapshot {
  formCode: string;
  formName: string;
  from: string;
  to: string;
  submissionChannel: string;
  boxes: {
    lineCode: string;
    label: string;
    value: string;
    computed: boolean;
    editable: boolean;
  }[];
  adjustments: Record<string, string>;
}

/**
 * Build the immutable filing snapshot and its SHA-256 fingerprint from a
 * computed return. Shared by prepare (captures the fingerprint) and mark-filed
 * (reproduces it) so the two paths can never disagree about what was hashed.
 */
export function buildTaxFilingSnapshot(
  result: TaxReturnResult,
  adjustments: Record<string, string>,
): { snapshot: TaxFilingSnapshot; snapshotHash: string } {
  const snapshot: TaxFilingSnapshot = {
    formCode: result.formCode,
    formName: result.formName,
    from: result.from,
    to: result.to,
    submissionChannel: result.submissionChannel,
    boxes: result.boxes.map((box) => ({
      lineCode: box.lineCode,
      label: box.label,
      value: box.value,
      computed: box.computed,
      editable: box.editable,
    })),
    adjustments,
  };
  const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { snapshot, snapshotHash };
}

type FilingRow = {
  id: string;
  form_code: string;
  period_from: string;
  period_to: string;
  status: "prepared" | "filed";
  adjustments: Record<string, string>;
  snapshot_hash: string;
};

/**
 * Every accounting period the filing window touches, closed for gl AND tax on
 * the primary book. Closure is evaluated with the same governing-lock order
 * the posting guard uses: a subsidiary-scoped row shadows the org-wide row,
 * so a reopened entity keeps the period open no matter what the tenant-wide
 * row says. No period rows, no primary book, or any scope not closed fails
 * closed.
 */
async function assertCoveredPeriodsClosed(
  orgId: string,
  from: string,
  to: string,
): Promise<void> {
  const book = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary limit 1`));
  const bookId = book.rows[0]?.id;
  if (!bookId) throw new TaxFilingError("period-not-closed", "no primary accounting book");

  const periods = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from accounting_periods
     where org_id = ${orgId} and is_adjustment = false
       and starts_on <= ${to} and ends_on >= ${from}
     order by starts_on`));
  if (periods.rows.length === 0) {
    throw new TaxFilingError(
      "period-not-closed",
      `no accounting period covers ${from}..${to} — generate the fiscal calendar before filing`,
    );
  }

  for (const module of ["gl", "tax"] as const) {
    for (const period of periods.rows) {
      const locks = (await db.execute<{
        subsidiary_id: string | null;
        state: string;
        reopen_expires_at: Date | string | null;
        reason: string | null;
      }>(sql`
        select subsidiary_id, state, reopen_expires_at, reason
          from period_locks
         where org_id = ${orgId} and period_id = ${period.id}
           and book_id = ${bookId} and module = ${module}`));
      const orgWide = locks.rows.find((row) => row.subsidiary_id === null) ?? null;
      const scopes: (string | null)[] = [null, ...locks.rows.map((r) => r.subsidiary_id).filter((s): s is string => s !== null)];
      for (const scope of scopes) {
        const governing =
          scope === null
            ? orgWide
            : (locks.rows.find((row) => row.subsidiary_id === scope) ?? orgWide);
        if (!governing || !periodLockBlocksPosting({
          state: governing.state,
          reopenExpiresAt: governing.reopen_expires_at,
          reason: governing.reason,
        }, false)) {
          throw new TaxFilingError(
            "period-not-closed",
            `period ${period.name} must be closed for ${module} before the filing can be marked filed`,
          );
        }
      }
    }
  }
}

/**
 * Record the one-way prepared → filed transition. Runs in one tenant
 * transaction: governance gate, live recompute + fingerprint verification,
 * then the status write and its audit evidence. Throws {@link TaxFilingError}
 * with a machine-readable code on every rejection path — nothing is written.
 */
export async function markTaxFilingFiled(
  orgId: string,
  filingId: string,
  actorId: string,
  filingReference: string | null,
): Promise<{ id: string; filedAt: Date }> {
  if (!actorId) {
    throw new TaxFilingError("not-found", "an attributable filing actor is required");
  }
  return await withOrg(orgId, async () => {
    const filing = (await db.execute<FilingRow>(sql`
      select id, form_code, period_from, period_to, status, adjustments, snapshot_hash
        from tax_filings
       where id = ${filingId} and org_id = ${orgId}
         for update`));
    const row = filing.rows[0];
    if (!row) throw new TaxFilingError("not-found", "tax filing not found");
    if (row.status !== "prepared") {
      throw new TaxFilingError("already-filed", "filing is already filed");
    }

    // Serialize against a concurrent prepare of the same period identity —
    // the exact advisory key the prepare path takes.
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${`tax-filing:${orgId}:${row.form_code}:${row.period_from}:${row.period_to}`}))`);

    // GOVERNANCE — the covered periods must be closed before certifying.
    await assertCoveredPeriodsClosed(orgId, row.period_from, row.period_to);

    // INTEGRITY — reproduce the prepare-time fingerprint from the live source
    // ledger. computeTaxReturn's reads run on this transaction's pinned
    // connection, so the verification and the write see one consistent world.
    let live: TaxReturnResult;
    try {
      live = await computeTaxReturn(
        orgId,
        row.form_code,
        row.period_from,
        row.period_to,
        row.adjustments ?? {},
      );
    } catch (error) {
      if (error instanceof TaxReturnError) {
        throw new TaxFilingError(
          "stale",
          `filing can no longer be verified against its source ledger (${error.message}) — prepare a new version`,
        );
      }
      throw error;
    }
    const { snapshotHash } = buildTaxFilingSnapshot(live, row.adjustments ?? {});
    if (snapshotHash !== row.snapshot_hash) {
      throw new TaxFilingError(
        "stale",
        "filing is stale: the covered period's ledger or return configuration changed after preparation — prepare a new version",
      );
    }

    const updated = (await db.execute<{ id: string; filed_at: Date }>(sql`
      update tax_filings
         set status = 'filed', filing_reference = ${filingReference}, filed_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where id = ${row.id} and org_id = ${orgId}
      returning id, filed_at`));
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_filings', ${row.id}, 'update',
              ${JSON.stringify({
                before: { status: "prepared" },
                after: {
                  status: "filed",
                  filingReference: filingReference,
                  snapshotHash: row.snapshot_hash,
                  sourceVerified: true,
                },
              })}::jsonb,
              ${actorId})`);
    return { id: updated.rows[0]!.id, filedAt: updated.rows[0]!.filed_at };
  });
}
