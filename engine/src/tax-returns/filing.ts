import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db, withOrg } from "../platform/db.ts";
import {
  computeTaxReturn,
  TaxReturnError,
  type TaxReturnResult,
  type TaxReturnTranslation,
} from "./return.ts";

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
 *     Filings prepared at snapshot v2 additionally fingerprint the return's
 *     identity and posture (registration number/id, functional and
 *     presentation currency, subsidiary scope, translation evidence), so a
 *     registration change or a currency/scope change trips stale even when
 *     every box value still matches. Pre-v2 filings verify boxes only.
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

/**
 * Snapshot schema version. v1 hashed form/period/channel/boxes/adjustments
 * only, so a registration change or a currency/scope posture change passed
 * the mark-filed staleness check whenever the box values still matched. v2
 * additionally hashes every identity/posture field below. Rows prepared
 * before the v2 columns existed keep version 1 and verify exactly as
 * prepared (boxes only) — they can never gain identity evidence that was
 * never frozen, and forcing them stale would strand every historical filing.
 */
export const TAX_FILING_SNAPSHOT_VERSION = 2;

export type TaxFilingSnapshotVersion = 1 | 2;

export interface TaxFilingSnapshot {
  /**
   * Present (2) on v2 snapshots; ABSENT on v1 so a v1 payload hashes
   * byte-identically to the hash its prepare stored.
   */
  version?: number;
  formCode: string;
  formName: string;
  from: string;
  to: string;
  submissionChannel: string;
  /** The org's registration number travelling on the return (v2 only). */
  registrationNumber?: string | null;
  /** The pinned or auto-matched tax_registrations id (v2 only). */
  registrationId?: string | null;
  /** Denomination of `boxes` (v2 only). */
  functionalCurrency?: string;
  /** Frozen filing-entity scope, sorted (v2 only). */
  subsidiaryIds?: string[];
  /** Translation evidence for a translated consolidated view (v2 only). */
  translation?: TaxReturnTranslation | null;
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
 *
 * `version` selects the schema: 2 (the default) for new filings, 1 to
 * reproduce the fingerprint of a pre-identity filing. Array order is
 * significant to the hash, so subsidiary ids sort here — the engine's scope
 * resolution reads subsidiaries in unspecified row order and two reads of the
 * same scope must fingerprint identically. Translation entities arrive sorted
 * from the return and are re-sorted defensively for the same reason; object
 * keys are normalized by canonicalJson.
 */
export function buildTaxFilingSnapshot(
  result: TaxReturnResult,
  adjustments: Record<string, string>,
  version: TaxFilingSnapshotVersion = TAX_FILING_SNAPSHOT_VERSION,
): { snapshot: TaxFilingSnapshot; snapshotHash: string } {
  const boxes = result.boxes.map((box) => ({
    lineCode: box.lineCode,
    label: box.label,
    value: box.value,
    computed: box.computed,
    editable: box.editable,
  }));
  const snapshot: TaxFilingSnapshot =
    version === 1
      ? {
          formCode: result.formCode,
          formName: result.formName,
          from: result.from,
          to: result.to,
          submissionChannel: result.submissionChannel,
          boxes,
          adjustments,
        }
      : {
          version: 2,
          formCode: result.formCode,
          formName: result.formName,
          from: result.from,
          to: result.to,
          submissionChannel: result.submissionChannel,
          registrationNumber: result.registrationNumber,
          registrationId: result.registrationId,
          functionalCurrency: result.functionalCurrency,
          subsidiaryIds: [...result.subsidiaryIds].sort(),
          translation: result.translation
            ? {
                ...result.translation,
                entities: [...result.translation.entities].sort((a, b) =>
                  a.subsidiaryId.localeCompare(b.subsidiaryId),
                ),
              }
            : null,
          boxes,
          adjustments,
        };
  // JSONB does not preserve object insertion order. Canonicalize before
  // hashing so prepare and mark-filed derive the same fingerprint after the
  // adjustments object makes a database round trip.
  const snapshotHash = createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
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
  snapshot_version: number | null;
};

/**
 * Every accounting period the filing window touches, closed for gl AND tax on
 * the primary book. A tax return is organization-scoped, so its covered legal
 * entities are the active, non-elimination subsidiaries. The effective lock
 * for each entity is its subsidiary row when one exists, otherwise the
 * org-wide default. This means an org-wide close may govern every entity, but
 * a scoped close must cover every entity and a scoped reopen cannot be hidden
 * by an older org-wide close. Only an explicit `closed` state is evidence;
 * open, soft-closed, or lapsed-reopen rows fail closed.
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
      const closure = (await db.execute<{
        covered: number;
        closed: number;
        org_wide_closed: number;
      }>(sql`
        with covered_entities as (
          select s.id
            from subsidiaries s
           where s.org_id = ${orgId}
             and s.is_active
             and not s.is_elimination
        )
        select
          count(*)::int as covered,
          count(*) filter (
            where coalesce(scoped.state, org_wide.state) = 'closed'
          )::int as closed,
          (
            select count(*)::int
              from period_locks l
             where l.org_id = ${orgId}
               and l.period_id = ${period.id}
               and l.book_id = ${bookId}
               and l.module = ${module}
               and l.subsidiary_id is null
               and l.state = 'closed'
          ) as org_wide_closed
          from covered_entities entity
          left join period_locks scoped
            on scoped.org_id = ${orgId}
           and scoped.period_id = ${period.id}
           and scoped.book_id = ${bookId}
           and scoped.module = ${module}
           and scoped.subsidiary_id = entity.id
          left join period_locks org_wide
            on org_wide.org_id = ${orgId}
           and org_wide.period_id = ${period.id}
           and org_wide.book_id = ${bookId}
           and org_wide.module = ${module}
           and org_wide.subsidiary_id is null`));
      const row = closure.rows[0];
      const covered = Number(row?.covered ?? 0);
      const closed = Number(row?.closed ?? 0);
      const orgWideClosed = Number(row?.org_wide_closed ?? 0) > 0;
      // Organizations normally always have a root subsidiary. If malformed
      // data leaves no active legal entity, retain the historical org-wide
      // fence rather than accidentally treating an empty set as closed.
      const satisfiesFence = covered === 0 ? orgWideClosed : closed === covered;
      if (!satisfiesFence) {
        throw new TaxFilingError(
          "period-not-closed",
          `period ${period.name} must be closed for ${module} across every covered subsidiary before the filing can be marked filed`,
        );
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
      select id, form_code, period_from, period_to, status, adjustments, snapshot_hash,
             snapshot_version
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
    // ledger on this transaction's pinned connection: computeTaxReturn runs on
    // the caller's executor, so verification and the status write hold exactly
    // one pool connection and see one consistent world. (A dedicated handle
    // here would pin a second pool client for the whole recompute and
    // deadlock a saturated pool.)
    let live: TaxReturnResult;
    try {
      live = await computeTaxReturn(
        orgId,
        row.form_code,
        row.period_from,
        row.period_to,
        row.adjustments ?? {},
        { runner: db },
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
    // The fingerprint schema is the filing's own: a pre-identity (v1) filing
    // reproduces its boxes-only hash, so it verifies exactly as prepared; a
    // v2 filing additionally reproduces its registration, currency and scope
    // posture, so any of those drifting after preparation trips stale.
    const snapshotVersion = row.snapshot_version === 2 ? 2 : 1;
    const { snapshotHash } = buildTaxFilingSnapshot(live, row.adjustments ?? {}, snapshotVersion);
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
