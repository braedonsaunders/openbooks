/** Read-only depreciation preview. Split from assets/depreciation.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { add } from "../money/money.ts";
import { resolveAssetAccounts } from "./depreciation-schedule-math.ts";
import { previewDepreciationFingerprint, type FingerprintedDepreciationRow } from "./depreciation-run-scope.ts";

export interface DepreciationPreviewInput {
  asOfDate: string;
  bookId?: string;
  periodId?: string;
  assetIds?: string[];
  allowedSubsidiaryIds?: string[];
  /** Operator-chosen posting date, fingerprinted but not projected. */
  postingDate?: string;
}


export interface DepreciationPreviewRow extends FingerprintedDepreciationRow {
  assetId: string;
  assetNumber: string;
  assetName: string;
  subsidiaryName: string | null;
  departmentName: string | null;
  projectName: string | null;
  locationName: string | null;
  bookName: string;
  postsGl: boolean;
  periodName: string;
  periodEndsOn: string;
  debitAccountNumber: string | null;
  debitAccountName: string | null;
  creditAccountNumber: string | null;
  creditAccountName: string | null;
  /** False when a resolved account no longer exists: Confirm reports it per asset. */
  accountsResolved: boolean;
}

export interface DepreciationPreview {
  asOfDate: string;
  bookId: string | null;
  periodId: string | null;
  postingDate: string | null;
  rows: DepreciationPreviewRow[];
  totalAmount: string;
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  /** Schedules that need extension: Confirm extends them first, but newly
   *  projected lines stay for the next run — only previewed lines post. */
  staleAssets: { assetId: string; assetNumber: string; assetName: string }[];
  warnings: string[];
  /**
   * Stale-input fence: sha256 over the inputs plus every previewed line id,
   * amount, period, book, account, subsidiary, and dimension. Confirm
   * recomputes over current state and refuses on mismatch.
   */
  fingerprint: string;
}


/**
 * Read-only depreciation preview: the exact accounting impact of confirming
 * the current selection — one balanced debit/credit pair per due line —
 * plus a fingerprint Confirm must carry back. Pure SELECTs: no locks, no
 * schedule extension, no claims, no postings. Stale schedules are REPORTED
 * (staleAssets + warnings), never extended here — and Confirm refuses while
 * any in-scope schedule is stale, so stored-line previews can never silently
 * omit due months that month-end rollover has not projected yet.
 */
export async function previewDepreciation(
  orgId: string,
  input: DepreciationPreviewInput,
): Promise<DepreciationPreview> {
  const scopedAssetIds =
    input.assetIds && input.assetIds.length > 0 ? [...new Set(input.assetIds)] : undefined;
  const due = (await db.execute<{
    line_id: string;
    asset_id: string;
    asset_number: string;
    asset_name: string;
    subsidiary_id: string;
    subsidiary_name: string | null;
    department_id: string | null;
    department_name: string | null;
    project_id: string | null;
    project_name: string | null;
    location_id: string | null;
    location_name: string | null;
    book_id: string;
    book_name: string;
    posts_gl: boolean;
    period_id: string;
    period_name: string;
    period_ends_on: string;
    period_starts_on: string;
    amount: string;
    asset_account: string | null;
    asset_accum: string | null;
    asset_expense: string | null;
    cat_asset: string;
    cat_accum: string;
    cat_expense: string;
  }>(sql`
    select l.id as line_id,
           a.id as asset_id, a.asset_number, a.name as asset_name,
           a.subsidiary_id, sub.name as subsidiary_name,
           a.department_id, dpt.name as department_name,
           a.project_id, prj.name as project_name,
           a.location_id, loc.name as location_name,
           s.book_id, bk.name as book_name, bk.posts_gl,
           l.period_id, p.name as period_name, p.ends_on::text as period_ends_on,
           p.starts_on::text as period_starts_on,
           l.planned_amount::text as amount,
           a.asset_account_id as asset_account,
           a.accumulated_depreciation_account_id as asset_accum,
           a.depreciation_expense_account_id as asset_expense,
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
      left join departments dpt on dpt.id = a.department_id and dpt.org_id = a.org_id
      left join projects prj on prj.id = a.project_id and prj.org_id = a.org_id
      left join locations loc on loc.id = a.location_id and loc.org_id = a.org_id
     where l.org_id = ${orgId}
       and l.posted_amount is null
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and p.ends_on <= ${input.asOfDate}
       ${input.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(input.allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${scopedAssetIds ? sql`and a.id = any(${uuidArray(scopedAssetIds)}::uuid[])` : sql``}
       ${input.bookId ? sql`and s.book_id = ${input.bookId}` : sql``}
       ${input.periodId ? sql`and l.period_id = ${input.periodId}` : sql``}
     order by a.asset_number, p.ends_on, l.sequence`));

  const accountIds = new Set<string>();
  const resolved = due.rows.map((row) => {
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
    accountIds.add(accounts.depreciationExpenseAccountId);
    accountIds.add(accounts.accumulatedDepreciationAccountId);
    return { row, accounts };
  });
  const accountMeta =
    accountIds.size > 0
      ? await db.execute<{ id: string; number: string | null; name: string | null }>(sql`
        select id, number, name from accounts
         where org_id = ${orgId} and id = any(${uuidArray([...accountIds])}::uuid[])`)
      : { rows: [] as { id: string; number: string | null; name: string | null }[] };
  const metaById = new Map(accountMeta.rows.map((account) => [String(account.id), account]));

  // One balanced pair per line: debits and credits accumulate independently
  // and the equality is asserted, not assumed, before the fingerprint.
  let totalAmount = "0";
  let totalDebits = "0";
  let totalCredits = "0";
  const rows: DepreciationPreviewRow[] = resolved.map(({ row, accounts }) => {
    const debit = metaById.get(accounts.depreciationExpenseAccountId);
    const credit = metaById.get(accounts.accumulatedDepreciationAccountId);
    totalAmount = add(totalAmount, String(row.amount));
    totalDebits = add(totalDebits, String(row.amount));
    totalCredits = add(totalCredits, String(row.amount));
    return {
      lineId: String(row.line_id),
      assetId: String(row.asset_id),
      assetNumber: String(row.asset_number),
      assetName: String(row.asset_name),
      subsidiaryId: String(row.subsidiary_id),
      subsidiaryName: row.subsidiary_name ? String(row.subsidiary_name) : null,
      departmentId: row.department_id ? String(row.department_id) : null,
      departmentName: row.department_name ? String(row.department_name) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      projectName: row.project_name ? String(row.project_name) : null,
      locationId: row.location_id ? String(row.location_id) : null,
      locationName: row.location_name ? String(row.location_name) : null,
      bookId: String(row.book_id),
      bookName: String(row.book_name),
      postsGl: row.posts_gl === true,
      periodId: String(row.period_id),
      periodName: String(row.period_name),
      periodEndsOn: String(row.period_ends_on),
      amount: String(row.amount),
      debitAccountId: accounts.depreciationExpenseAccountId,
      debitAccountNumber: debit?.number ? String(debit.number) : null,
      debitAccountName: debit?.name ? String(debit.name) : null,
      creditAccountId: accounts.accumulatedDepreciationAccountId,
      creditAccountNumber: credit?.number ? String(credit.number) : null,
      creditAccountName: credit?.name ? String(credit.name) : null,
      accountsResolved: !!debit && !!credit,
      evidence: row.posts_gl === true ? "gl-posting" : "reporting-only",
    };
  });

  // Stale-schedule detection is the run's extension query minus the
  // extension: reported here, never executed.
  const stale = (await db.execute<{
    asset_id: string;
    asset_number: string;
    asset_name: string;
  }>(sql`
    select distinct s.asset_id, a.asset_number, a.name as asset_name
      from depreciation_schedules s
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
     where s.org_id = ${orgId}
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and (s.method not in ('manual', 'units_of_production') or s.depreciation_method_id is not null)
       ${input.allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(input.allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${scopedAssetIds ? sql`and a.id = any(${uuidArray(scopedAssetIds)}::uuid[])` : sql``}
       ${input.bookId ? sql`and s.book_id = ${input.bookId}` : sql``}
       and exists (
         select 1 from accounting_periods p
          where p.org_id = s.org_id and not p.is_adjustment
            and p.ends_on > coalesce((
              select max(pp.ends_on)
                from depreciation_schedule_lines l
                join accounting_periods pp on pp.id = l.period_id and pp.org_id = l.org_id
               where l.org_id = s.org_id and l.schedule_id = s.id
            ), date '0001-01-01')
       )`));
  const staleAssets = stale.rows.map((row) => ({
    assetId: String(row.asset_id),
    assetNumber: String(row.asset_number),
    assetName: String(row.asset_name),
  }));

  const warnings: string[] = [];
  const unresolved = rows.filter((row) => !row.accountsResolved);
  if (unresolved.length > 0) {
    warnings.push(
      `${unresolved.length} line${unresolved.length === 1 ? "" : "s"} resolve${unresolved.length === 1 ? "s" : ""} to a missing account and will be reported per asset at Confirm instead of posting.`,
    );
  }
  if (staleAssets.length > 0) {
    warnings.push(
      `${staleAssets.length} asset${staleAssets.length === 1 ? "" : "s"} need${staleAssets.length === 1 ? "s" : ""} a schedule rebuild (month-end rollover) before Confirm: ${staleAssets.map((asset) => asset.assetNumber).join(", ")}. Rebuild their schedules, then preview again.`,
    );
  }
  if (input.postingDate) {
    // A posting date that misses a previewed line's own period is a stable
    // operator-input outcome, not drift: warn now, and Confirm skips those
    // lines by name instead of posting them on a date outside their period.
    for (const row of due.rows) {
      const startsOn = row.period_starts_on;
      if (!startsOn) continue;
      if (input.postingDate < startsOn || input.postingDate > String(row.period_ends_on)) {
        warnings.push(
          `posting date ${input.postingDate} falls outside ${row.period_name} (${row.asset_number}); Confirm will skip that line.`,
        );
      }
    }
  }

  const balanced = totalDebits === totalCredits;
  if (!balanced) {
    throw new Error("depreciation preview is out of balance; refusing to fingerprint");
  }
  const fingerprint = previewDepreciationFingerprint(
    orgId,
    {
      asOfDate: input.asOfDate,
      bookId: input.bookId,
      periodId: input.periodId,
      assetIds: scopedAssetIds,
      postingDate: input.postingDate,
    },
    rows,
  );
  return {
    asOfDate: input.asOfDate,
    bookId: input.bookId ?? null,
    periodId: input.periodId ?? null,
    postingDate: input.postingDate ?? null,
    rows,
    totalAmount,
    totalDebits,
    totalCredits,
    balanced,
    staleAssets,
    warnings,
    fingerprint,
  };
}
