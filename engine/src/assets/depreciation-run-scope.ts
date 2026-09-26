/** Shared run/confirm/preview scope: fingerprint rows, claim shapes, confirm gate. Split from assets/depreciation.ts (pure moves only). */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { resolveAssetAccounts } from "./depreciation-schedule-math.ts";

// ---------------------------------------------------------------------------
// runDepreciation — recognize due periods in each accounting book
// ---------------------------------------------------------------------------

export interface NextDueDepreciation {
  assetNumber: string;
  period: string;
  endsOn: string;
  amount: string;
}

export interface RunDepreciationResult {
  /** Number of GL journal entries posted. */
  posted: number;
  /** Number of reporting-only book lines recognized without a GL entry. */
  recorded: number;
  recordedAmount: string;
  skipped: number;
  totalAmount: string;
  entries: { assetId: string; assetNumber: string; period: string; amount: string; entryId: string; lineId: string }[];
  /** Reporting-only recognitions with their immutable line evidence. */
  recordedEntries: { assetId: string; assetNumber: string; period: string; amount: string; lineId: string }[];
  /** Lines examined but not recognized, with the reason named per asset. */
  skippedAssets: { assetNumber: string; period: string; reason: string }[];
  /** Structured per-asset problems; `problems` keeps the legacy strings. */
  problemItems: { assetNumber: string; period: string; message: string; assetId?: string; lineId?: string }[];
  problems: string[];
  /** The as-of date the run evaluated (defaults to the org business day). */
  asOfDate: string;
  /** Earliest unrecognized line in scope when nothing was recognized, else null. */
  nextDue: NextDueDepreciation | null;
}

/** Keep the lifecycle state aligned with the current primary-book carrying value. */
export async function reconcileAssetDepreciationStatusWithRunner(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  assetId?: string,
  allowedSubsidiaryIds?: readonly string[],
): Promise<void> {
  // Obtain a fresh carrying-value snapshot after any competing lifecycle write.
  // The caller keeps these locks through its financial transaction.
  await runner.execute(sql`
    select id from fixed_assets
     where org_id = ${orgId} and status in ('in_service', 'fully_depreciated')
       ${allowedSubsidiaryIds ? sql`and subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${assetId ? sql`and id = ${assetId}` : sql``}
     order by id for update`);
  await runner.execute(sql`
    with carrying as materialized (
      select a.id, a.status as previous_status, book.id as book_id,
             carrying_values.carrying_value as amount,
             carrying_values.salvage as salvage_value
        from fixed_assets a
        join accounting_books book on book.org_id = a.org_id and book.is_primary and book.is_active and book.posts_gl
        join asset_book_carrying_values carrying_values on carrying_values.org_id=a.org_id and carrying_values.asset_id=a.id and carrying_values.book_id=book.id
       where a.org_id = ${orgId} and a.status in ('in_service', 'fully_depreciated')
         ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
         ${assetId ? sql`and a.id = ${assetId}` : sql``}
    ), changed as (
    update fixed_assets asset
       set status = case when carrying.amount <= carrying.salvage_value then 'fully_depreciated' else 'in_service' end,
           updated_at = now(), updated_by = ${actorId}
      from carrying
     where asset.org_id = ${orgId} and asset.id = carrying.id
       and asset.status <> case when carrying.amount <= carrying.salvage_value then 'fully_depreciated' else 'in_service' end
    returning asset.id, carrying.previous_status, asset.status, carrying.amount, carrying.salvage_value, carrying.book_id
    )
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    select ${orgId}, 'fixed_assets', id, 'update', jsonb_build_object(
      'before', jsonb_build_object('status', previous_status),
      'after', jsonb_build_object('status', status),
      'reason', 'Reconcile asset lifecycle with primary-book carrying value',
      'bookId', book_id, 'carryingValue', amount::text, 'salvageValue', salvage_value::text
    ), ${actorId} from changed`);
}

export interface ExpectedDepreciationLine extends FingerprintedDepreciationRow {
  assetId: string;
}

export interface RunDepreciationScope {
  /** Post only these assets (in addition to the legacy single-asset scope). */
  assetIds?: string[];
  /** Post only lines in this accounting period. */
  periodId?: string;
  /**
   * Post only these schedule lines: the confirmed preview set. Stale
   * schedules are still extended first, but newly projected lines stay for
   * the next run — Confirm never silently posts rows it did not preview.
   */
  lineIds?: string[];
  /**
   * Lock-time verification of the confirmed preview: every field the
   * fingerprint covers, rechecked after the claim reloads the line under
   * FOR UPDATE. A line whose amount, period, book, accounts, subsidiary,
   * dimensions, or GL/reporting classification drifted since preview is
   * skipped with a named reason — re-preview then confirms the new values.
   * Absent (legacy immediate runs): no verification, historic behavior.
   */
  expectedLines?: ExpectedDepreciationLine[];
  /**
   * Operator-chosen posting date for generated journal entries (ISO date).
   * Must fall inside each line's own accounting period; a line it misses is
   * skipped by name. Absent: each entry posts on its period end date.
   */
  postingDate?: string;
  /**
   * Confirmed preview hash for the all-or-nothing batch gate. Compared
   * against the fingerprint recomputed over the locked reload; mismatch
   * aborts the batch before any write.
   */
  expectedFingerprint?: string;
}

/** Thrown by the confirm batch gate: the locked state no longer matches the
 *  fingerprinted preview. The route maps this to 409 stale_preview — a batch
 *  refusal before any recognition or journal write, never a per-line skip. */
export class StalePreviewError extends Error {}

/**
 * All-or-nothing gate for a fingerprinted Confirm. In ONE transaction, lock
 * the complete pinned candidate set plus every referenced configuration row
 * (assets, categories, subsidiaries, lines, books, periods, accounts,
 * dimensions — each in deterministic id order, the same relative order as
 * the per-line posting path), reload the full preview projection for the
 * pinned lines, and compare the recomputed fingerprint. Any drift throws
 * StalePreviewError BEFORE any recognition or journal write, so a Confirm
 * can never post early lines and only later discover a stale one. Lines a
 * concurrent run already recognized are returned for loud skip seeding —
 * a genuine execution outcome, not drift.
 */
export async function assertConfirmSetCurrent(
  tx: SqlExecutor,
  orgId: string,
  input: { asOfDate: string; bookId?: string; periodId?: string; assetIds?: string[]; postingDate?: string },
  expectedLines: ExpectedDepreciationLine[],
  allowedSubsidiaryIds?: string[],
  expectedFingerprint?: string,
): Promise<{ lineId: string; assetNumber: string; periodName: string }[]> {
  const byId = new Map(expectedLines.map((line) => [line.lineId, line]));
  const lineIds = [...byId.keys()].sort();
  const assetIds = [...new Set(expectedLines.map((line) => line.assetId))].sort();
  const alreadyPosted: { lineId: string; assetNumber: string; periodName: string }[] = [];
  if (lineIds.length === 0) return alreadyPosted;

  const assets = (await tx.execute<{ id: string; category_id: string }>(sql`
    select id, category_id from fixed_assets
     where org_id = ${orgId} and id = any(${uuidArray(assetIds)}::uuid[])
     order by id for update`));
  const foundAssets = new Set(assets.rows.map((row) => String(row.id)));
  const missingAsset = assetIds.find((id) => !foundAssets.has(id));
  if (missingAsset) {
    throw new StalePreviewError(`asset ${missingAsset} left the confirmed scope; re-preview before confirming`);
  }
  const categoryIds = [...new Set(assets.rows.map((row) => String(row.category_id)))].sort();
  await tx.execute(sql`
    select id from asset_categories
     where org_id = ${orgId} and id = any(${uuidArray(categoryIds)}::uuid[])
     order by id for update`);
  await tx.execute(sql`
    select id from subsidiaries
     where org_id = ${orgId}
     order by id
     for update`);

  const reloaded = (await tx.execute<{
    line_id: string;
    planned_amount: string;
    posted_amount: string | null;
    period_id: string;
    book_id: string;
    posts_gl: boolean;
    period_name: string;
    asset_number: string;
    subsidiary_id: string;
    asset_account: string | null;
    asset_accum: string | null;
    asset_expense: string | null;
    department_id: string | null;
    project_id: string | null;
    location_id: string | null;
    cat_asset: string;
    cat_accum: string;
    cat_expense: string;
  }>(sql`
    select l.id as line_id,
           l.planned_amount::text as planned_amount,
           l.posted_amount::text as posted_amount,
           l.period_id,
           s.book_id,
           bk.posts_gl,
           p.name as period_name,
           a.asset_number,
           a.subsidiary_id,
           a.asset_account_id as asset_account,
           a.accumulated_depreciation_account_id as asset_accum,
           a.depreciation_expense_account_id as asset_expense,
           a.department_id,
           a.project_id,
           a.location_id,
           c.asset_account_id as cat_asset,
           c.accumulated_depreciation_account_id as cat_accum,
           c.depreciation_expense_account_id as cat_expense
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.id = any(${uuidArray(lineIds)}::uuid[])
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and p.ends_on <= ${input.asOfDate}
       ${input.bookId ? sql`and s.book_id = ${input.bookId}` : sql``}
       ${input.periodId ? sql`and l.period_id = ${input.periodId}` : sql``}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
     order by l.id
     for update`));

  // Full-fingerprint comparison under the locks: every reloaded unposted
  // row is field-compared against its confirmed preview row (exactly the
  // fingerprinted fields), and the recomputed hash must equal the confirmed
  // one when provided. The first difference throws with the row named.
  const seen = new Set<string>();
  const fingerprinted: FingerprintedDepreciationRow[] = [];
  for (const row of reloaded.rows) {
    const id = String(row.line_id);
    seen.add(id);
    const assetNumber = String(row.asset_number);
    const periodName = String(row.period_name);
    // Loose null: real rows read NULL, while a missing key (partial
    // projections) must not misclassify a due line as recognized.
    if (row.posted_amount != null) {
      alreadyPosted.push({ lineId: id, assetNumber, periodName });
      continue;
    }
    const accounts = resolveAssetAccounts(
      {
        assetAccountId: row.asset_account,
        accumulatedDepreciationAccountId: row.asset_accum,
        depreciationExpenseAccountId: row.asset_expense,
      },
      {
        assetAccountId: row.cat_asset,
        accumulatedDepreciationAccountId: row.cat_accum,
        depreciationExpenseAccountId: row.cat_expense,
      },
    );
    const current = {
      lineId: id,
      amount: String(row.planned_amount),
      periodId: String(row.period_id),
      bookId: String(row.book_id),
      debitAccountId: accounts.depreciationExpenseAccountId,
      creditAccountId: accounts.accumulatedDepreciationAccountId,
      subsidiaryId: String(row.subsidiary_id),
      departmentId: row.department_id ? String(row.department_id) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      locationId: row.location_id ? String(row.location_id) : null,
      evidence: (row.posts_gl ? "gl-posting" : "reporting-only") as "gl-posting" | "reporting-only",
    };
    const expected = byId.get(id);
    if (!expected) {
      throw new StalePreviewError(
        `${assetNumber} ${periodName}: line was not in the confirmed preview; re-preview before confirming`,
      );
    }
    const drift = previewLineDrift(
      expected,
      {
        planned_amount: current.amount,
        period_id: current.periodId,
        book_id: current.bookId,
        subsidiary_id: current.subsidiaryId,
        department_id: current.departmentId,
        project_id: current.projectId,
        location_id: current.locationId,
        posts_gl: current.evidence === "gl-posting",
      },
      {
        depreciationExpenseAccountId: current.debitAccountId,
        accumulatedDepreciationAccountId: current.creditAccountId,
      },
    );
    if (drift) {
      throw new StalePreviewError(
        `${assetNumber} ${periodName}: changed since preview (${drift}); re-preview before confirming`,
      );
    }
    fingerprinted.push(current);
  }
  const missing = lineIds.find(
    (id) => !seen.has(id) && !alreadyPosted.some((line) => line.lineId === id),
  );
  if (missing) {
    const expected = byId.get(missing);
    throw new StalePreviewError(
      `${expected ? `${expected.assetId} ` : ""}line ${missing} is no longer due; re-preview before confirming`,
    );
  }
  // Referenced configuration in deterministic id order, AFTER the candidate
  // set — the same relative order as the validation pass (assets, categories,
  // subsidiaries, lines, accounts, dimensions), so concurrent batches
  // serialize instead of deadlocking.
  const gateAccountIds = [
    ...new Set(expectedLines.flatMap((line) => [line.debitAccountId, line.creditAccountId])),
  ].sort();
  if (gateAccountIds.length > 0) {
    await tx.execute(sql`
      select id from accounts
       where org_id = ${orgId} and id = any(${uuidArray(gateAccountIds)}::uuid[])
       order by id for update`);
  }
  const gateDims = [
    { table: "departments", ids: expectedLines.map((line) => line.departmentId) },
    { table: "projects", ids: expectedLines.map((line) => line.projectId) },
    { table: "locations", ids: expectedLines.map((line) => line.locationId) },
  ] as const;
  for (const dim of gateDims) {
    const ids = [...new Set(dim.ids.filter(Boolean))].sort() as string[];
    if (ids.length === 0) continue;
    await tx.execute(sql`
      select id from ${sql.raw(dim.table)}
       where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])
       order by id for update`);
  }
  // Literal hash recomparison over the locked reload. Already-recognized
  // lines are immutable history excluded from the comparison: they seed
  // loud skips below, and their presence would trivially change the hash.
  if (expectedFingerprint !== undefined && alreadyPosted.length === 0) {
    const recomputed = previewDepreciationFingerprint(orgId, input, fingerprinted);
    if (recomputed !== expectedFingerprint) {
      throw new StalePreviewError(
        `confirmed set changed; re-preview before confirming`,
      );
    }
  }
  return alreadyPosted;
}

/** Aborts a fingerprinted Confirm batch on a closed period, naming the row.
 *  The route maps this to 409 period_closed — open the period, then confirm
 *  again. Never a per-line skip: the batch posts every line or none. */
export class ClosedBatchError extends Error {
  assetNumber: string;
  periodName: string;
  constructor(assetNumber: string, periodName: string) {
    super(
      `${assetNumber} ${periodName}: GL period closed; open the period and confirm again`,
    );
    this.assetNumber = assetNumber;
    this.periodName = periodName;
  }
}

/** Line state reloaded under FOR UPDATE for posting (claim shape). */
export type ClaimedDepreciationLine = {
  line_id: string;
  planned_amount: string;
  period_id: string;
  book_id: string;
  posts_gl: boolean;
  period_name: string;
  period_ends_on: string;
  period_starts_on: string;
  period_ends_text: string;
  asset_id: string;
  subsidiary_id: string;
  base_currency: string;
  asset_number: string;
  asset_name: string;
  asset_account: string | null;
  asset_accum: string | null;
  asset_expense: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  cat_asset: string;
  cat_accum: string;
  cat_expense: string;
};
/** Exactly the fields the confirm fingerprint covers per row. */
export interface FingerprintedDepreciationRow {
  lineId: string;
  amount: string;
  periodId: string;
  bookId: string;
  debitAccountId: string;
  creditAccountId: string;
  subsidiaryId: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  evidence: "gl-posting" | "reporting-only";
}
/**
 * Pure lock-time comparison of one confirmed preview row against its
 * claim-time reload. Returns the first difference as a human-readable
 * fragment for the named skip reason, or null when the locked state still
 * matches exactly what the operator reviewed.
 */
export function previewLineDrift(
  expected: ExpectedDepreciationLine,
  claimed: Pick<
    ClaimedDepreciationLine,
    | "planned_amount"
    | "period_id"
    | "book_id"
    | "subsidiary_id"
    | "department_id"
    | "project_id"
    | "location_id"
    | "posts_gl"
  >,
  accounts: { depreciationExpenseAccountId: string; accumulatedDepreciationAccountId: string },
): string | null {
  const same = (label: string, locked: string | null, reviewed: string | null): string | null =>
    (locked ?? null) !== (reviewed ?? null)
      ? `${label} ${reviewed ?? "—"} → ${locked ?? "—"}`
      : null;
  return (
    same("amount", String(claimed.planned_amount), expected.amount) ??
    same("period", String(claimed.period_id), expected.periodId) ??
    same("book", String(claimed.book_id), expected.bookId) ??
    same("debit account", accounts.depreciationExpenseAccountId, expected.debitAccountId) ??
    same("credit account", accounts.accumulatedDepreciationAccountId, expected.creditAccountId) ??
    same("subsidiary", String(claimed.subsidiary_id), expected.subsidiaryId) ??
    same("department", claimed.department_id, expected.departmentId) ??
    same("project", claimed.project_id, expected.projectId) ??
    same("location", claimed.location_id, expected.locationId) ??
    same(
      "posting classification",
      claimed.posts_gl ? "gl-posting" : "reporting-only",
      expected.evidence,
    )
  );
}

/**
 * Fingerprint the exact confirmable set. Covers the projected candidate
 * rows AND every account/dimension/book/period input, so no silent extra
 * row and no silent reconfiguration can slip between preview and Confirm.
 */
export function previewDepreciationFingerprint(
  orgId: string,
  input: { asOfDate: string; bookId?: string; periodId?: string; assetIds?: string[]; postingDate?: string },
  rows: FingerprintedDepreciationRow[],
): string {
  const normalized = {
    orgId,
    asOfDate: input.asOfDate,
    bookId: input.bookId ?? null,
    periodId: input.periodId ?? null,
    assetIds: [...(input.assetIds ?? [])].sort(),
    postingDate: input.postingDate ?? null,
    rows: [...rows]
      .sort((a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0))
      .map((row) => ({
        lineId: row.lineId,
        amount: row.amount,
        periodId: row.periodId,
        bookId: row.bookId,
        debitAccountId: row.debitAccountId,
        creditAccountId: row.creditAccountId,
        subsidiaryId: row.subsidiaryId,
        departmentId: row.departmentId,
        projectId: row.projectId,
        locationId: row.locationId,
        evidence: row.evidence,
      })),
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
