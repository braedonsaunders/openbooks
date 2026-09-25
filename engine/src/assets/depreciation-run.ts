/** Depreciation run: claim reload, confirm batch, recognition. Split from assets/depreciation.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor, withTransactionSavepoint } from "../platform/db.ts";
import { assertFinalKernelBalance } from "../journal/posting-invariants.ts";
import { postEntry } from "../journal/post-entry.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { add, isZero, neg } from "../money/money.ts";
import { DepreciationRefusalError } from "./depreciation-errors.ts";
import { resolveAssetAccounts, type AssetAccounts } from "./depreciation-schedule-math.ts";
import { buildSchedule } from "./depreciation-schedule-build.ts";
import { ClosedBatchError, StalePreviewError, assertConfirmSetCurrent, reconcileAssetDepreciationStatusWithRunner, type ClaimedDepreciationLine, type ExpectedDepreciationLine, type RunDepreciationResult, type RunDepreciationScope } from "./depreciation-run-scope.ts";

/**
 * Recognize every due depreciation line through `asOfDate`. Posting books use
 * the kernel draft→lines→posted journal; reporting-only books freeze the same
 * subledger measurement with database-audited non-GL evidence. Both honor the
 * book's assets/GL close controls. The posted_amount claim makes either path
 * idempotent, including zero amounts. When nothing is recognized, name the
 * as-of date and next due line rather than returning unexplained zeroes.
 */
/**
 * Reload one due line under lock for posting. Shared by the legacy
 * per-line posting transactions and the confirm batch's validation pass.
 */
export async function reloadClaimLine(
  runner: SqlExecutor,
  orgId: string,
  lineId: string,
  asOfDate: string,
  allowedSubsidiaryIds: string[] | undefined,
): Promise<ClaimedDepreciationLine | null> {
  const claim = await runner.execute<ClaimedDepreciationLine>(sql`
    select l.id as line_id,
           l.planned_amount,
           l.period_id,
           s.book_id,
           bk.posts_gl,
           p.name as period_name,
           p.ends_on as period_ends_on,
           p.starts_on::text as period_starts_on,
           p.ends_on::text as period_ends_text,
           a.id as asset_id,
           a.subsidiary_id,
           sub.base_currency,
           a.asset_number,
           a.name as asset_name,
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
     where l.id = ${lineId}
       and l.org_id = ${orgId}
       and l.posted_amount is null
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and p.ends_on <= ${asOfDate}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
     for update of l for share of bk`);
  return claim.rows[0] ?? null;
}

/**
 * Fingerprinted Confirm executed as ONE all-or-nothing batch inside the
 * caller's outer transaction. Locks are held continuously from the gate
 * through the last posting:
 *
 * - gate: full-set + config locks, fingerprint recomputed and compared;
 *   drift throws StalePreviewError before any write;
 * - pass 1 (validation only, no writes): per pinned line, in deterministic
 *   line-id order — locks, claim reload, posting fence, open-period check
 *   (ClosedBatchError aborts the batch, never a per-line skip), account
 *   resolution, account/dimension locks, restriction validation, kernel
 *   balance. A posting date that misses a line's own period seeds a loud
 *   pending skip (a genuine operator-input outcome, stable across
 *   re-previews — not drift);
 * - pass 2 (writes only): recognizes or journal-posts every validated line.
 *
 * Any throw in pass 1 rolls back before the first write is issued; a throw
 * in pass 2 rolls back every write the batch issued. Either way the
 * fingerprinted batch posts all of its lines or none — drift is never
 * downgraded to per-line skips. Concurrently recognized lines seed loud
 * "line already posted" skips instead: immutable history, not drift.
 */
async function runConfirmBatch(
  outer: SqlExecutor,
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  allowedSubsidiaryIds: string[] | undefined,
  bookId: string | undefined,
  scope: RunDepreciationScope & { expectedLines: ExpectedDepreciationLine[] },
  result: RunDepreciationResult,
): Promise<void> {
  const alreadyPosted = await assertConfirmSetCurrent(
    outer,
    orgId,
    {
      asOfDate,
      bookId,
      periodId: scope.periodId,
      assetIds: scope.assetIds,
      postingDate: scope.postingDate,
    },
    scope.expectedLines,
    allowedSubsidiaryIds ? [...allowedSubsidiaryIds] : undefined,
    scope.expectedFingerprint,
  );
  for (const line of alreadyPosted) {
    result.skipped++;
    result.skippedAssets.push({
      assetNumber: line.assetNumber,
      period: line.periodName,
      reason: "line already posted",
    });
  }

  const lineIds = [...new Set(scope.expectedLines.map((line) => line.lineId))].sort();
  const scopedAssetIds =
    scope.assetIds && scope.assetIds.length > 0 ? [...new Set(scope.assetIds)] : undefined;
  const due = await outer.execute<{
    line_id: string;
    asset_id: string;
    asset_number: string;
    period_name: string;
  }>(sql`
    select l.id as line_id, a.id as asset_id,
           a.asset_number, p.name as period_name
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.posted_amount is null
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and p.ends_on <= ${asOfDate}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${scopedAssetIds ? sql`and a.id = any(${uuidArray(scopedAssetIds)}::uuid[])` : sql``}
       ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
       ${scope.periodId ? sql`and l.period_id = ${scope.periodId}` : sql``}
       and l.id = any(${uuidArray(lineIds)}::uuid[])
     order by l.id`);

  const validated: {
    lineId: string;
    assetId: string;
    claimed: ClaimedDepreciationLine;
    accounts: AssetAccounts;
    planned: string;
    postDate: string;
  }[] = [];
  for (const row of due.rows) {
    const assetLock = await outer.execute<{ category_id: string; subsidiary_id: string }>(sql`
      select category_id, subsidiary_id
        from fixed_assets
       where id = ${row.asset_id} and org_id = ${orgId}
       for update`);
    const assetKey = assetLock.rows[0];
    if (!assetKey) {
      throw new StalePreviewError(
        `asset ${row.asset_id} left the confirmed scope; re-preview before confirming`,
      );
    }
    const categoryLock = await outer.execute<{ id: string }>(sql`
      select id from asset_categories
       where id = ${assetKey.category_id} and org_id = ${orgId}
       for update`);
    if (!categoryLock.rows[0]) {
      throw new StalePreviewError(
        `${row.asset_number} ${row.period_name}: asset category changed; re-preview before confirming`,
      );
    }
    await outer.execute(sql`
      select id from subsidiaries
       where org_id = ${orgId}
       order by id
       for update`);
    const claimed = await reloadClaimLine(
      outer,
      orgId,
      String(row.line_id),
      asOfDate,
      allowedSubsidiaryIds ? [...allowedSubsidiaryIds] : undefined,
    );
    if (!claimed) {
      throw new StalePreviewError(
        `${row.asset_number} ${row.period_name}: line is no longer due; re-preview before confirming`,
      );
    }
    try {
      await outer.execute(
        sql`select period_posting_fence(${orgId}, ${claimed.period_id}, ${claimed.book_id})`,
      );
      if (
        !(await arePeriodModulesOpen(outer, {
          orgId,
          periodId: String(claimed.period_id),
          bookId: String(claimed.book_id),
          subsidiaryIds: [String(claimed.subsidiary_id)],
          modules: ["assets"],
        }))
      ) {
        throw new ClosedBatchError(claimed.asset_number, claimed.period_name);
      }
      const accounts = resolveAssetAccounts(
        {
          assetAccountId: claimed.asset_account,
          accumulatedDepreciationAccountId: claimed.asset_accum,
          depreciationExpenseAccountId: claimed.asset_expense,
        },
        {
          assetAccountId: claimed.cat_asset,
          accumulatedDepreciationAccountId: claimed.cat_accum,
          depreciationExpenseAccountId: claimed.cat_expense,
        },
      );
      const postingDate = scope.postingDate;
      if (
        postingDate &&
        (postingDate < claimed.period_starts_on || postingDate > claimed.period_ends_text)
      ) {
        const reason = `posting date ${postingDate} falls outside ${claimed.period_name}`;
        const message = `${claimed.asset_number} ${claimed.period_name}: ${reason}`;
        result.skipped++;
        result.skippedAssets.push({
          assetNumber: claimed.asset_number,
          period: claimed.period_name,
          reason,
        });
        result.problems.push(message);
        result.problemItems.push({
          assetNumber: claimed.asset_number,
          period: claimed.period_name,
          message,
          assetId: String(row.asset_id),
          lineId: String(row.line_id),
        });
        continue;
      }
      const accountIds = [
        ...new Set([
          accounts.assetAccountId,
          accounts.accumulatedDepreciationAccountId,
          accounts.depreciationExpenseAccountId,
        ]),
      ];
      await outer.execute(sql`
        select id from accounts
         where org_id = ${orgId}
           and id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
         order by id
         for update`);
      const dimensions = [
        { table: "departments", id: claimed.department_id },
        { table: "projects", id: claimed.project_id },
        { table: "locations", id: claimed.location_id },
      ] as const;
      for (const dimension of dimensions) {
        if (!dimension.id) continue;
        await outer.execute(sql`
          select id from ${sql.raw(dimension.table)}
           where org_id = ${orgId} and id = ${dimension.id}
           for update`);
      }
      const subsidiaryContext = await loadSubsidiaryContext(outer, orgId);
      const planned = String(claimed.planned_amount);
      const lines = [
        { accountId: accounts.depreciationExpenseAccountId, amount: planned },
        { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(planned) },
      ];
      await validateSubsidiaryRestrictions(outer, {
        orgId,
        ctx: subsidiaryContext,
        docSubsidiaryId: String(claimed.subsidiary_id),
        lines: lines.map((line) => ({
          ...line,
          subsidiaryId: String(claimed.subsidiary_id),
          departmentId: claimed.department_id ? String(claimed.department_id) : null,
          projectId: claimed.project_id ? String(claimed.project_id) : null,
          locationId: claimed.location_id ? String(claimed.location_id) : null,
        })),
      });
      assertFinalKernelBalance(
        lines.map((line) => ({ amount: line.amount, subsidiaryId: String(claimed.subsidiary_id) })),
      );
      validated.push({
        lineId: String(row.line_id),
        assetId: String(row.asset_id),
        claimed,
        accounts,
        planned,
        postDate: scope.postingDate ?? String(claimed.period_ends_on),
      });
    } catch (e: unknown) {
      if (e instanceof ClosedBatchError) throw e;
      if (e instanceof SubsidiaryError) {
        throw new StalePreviewError(
          `${claimed.asset_number} ${claimed.period_name}: ${(e as Error).message}; re-preview before confirming`,
        );
      }
      throw e;
    }
  }

  for (const line of validated) {
    const { claimed, accounts, planned } = line;
    if (!claimed.posts_gl || isZero(planned)) {
      const recorded = await outer.execute<{ id: string }>(sql`
        update depreciation_schedule_lines
           set posted_amount = ${planned},
               non_gl_recognized_at = ${claimed.posts_gl ? sql`null` : sql`clock_timestamp()`},
               updated_at = now(), updated_by = ${actorId}
         where id = ${line.lineId} and org_id = ${orgId} and posted_amount is null
         returning id`);
      if (recorded.rows.length !== 1) {
        throw new Error(
          "depreciation recognition did not record the claimed line; reload the schedule and retry",
        );
      }
      if (!claimed.posts_gl) {
        result.recorded++;
        result.recordedAmount = add(result.recordedAmount, planned);
        result.recordedEntries.push({
          assetId: line.assetId,
          assetNumber: claimed.asset_number,
          period: claimed.period_name,
          amount: planned,
          lineId: line.lineId,
        });
      } else {
        result.skipped++;
        result.skippedAssets.push({
          assetNumber: claimed.asset_number,
          period: claimed.period_name,
          reason: "zero planned amount",
        });
      }
      continue;
    }
    // Every journal write routes through the ONE ledger API.
    const postings = [
      { accountId: accounts.depreciationExpenseAccountId, amount: planned },
      { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(planned) },
    ];
    const postedEntry = await postEntry(outer, {
      orgId,
      bookId: claimed.book_id,
      subsidiaryId: claimed.subsidiary_id,
      entryNumber: `DEP-${claimed.asset_number}-${claimed.period_name}-${claimed.line_id}`,
      postingDate: line.postDate,
      periodId: claimed.period_id,
      memo: `Depreciation — ${claimed.asset_name} (${claimed.period_name})`,
      origin: "depreciation",
      actorId,
      currency: claimed.base_currency,
      lines: postings.map((posting) => ({
        accountId: posting.accountId,
        amount: posting.amount,
        departmentId: claimed.department_id,
        projectId: claimed.project_id,
        locationId: claimed.location_id,
        memo: `Depreciation ${claimed.period_name}`,
      })),
    });
    const eid = postedEntry.entryId;
    await outer.execute(sql`
      update depreciation_schedule_lines
         set posted_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
       where id = ${line.lineId} and org_id = ${orgId}`);
    result.posted++;
    result.totalAmount = add(result.totalAmount, planned);
    result.entries.push({
      assetId: line.assetId,
      assetNumber: claimed.asset_number,
      period: claimed.period_name,
      amount: planned,
      entryId: eid,
      lineId: line.lineId,
    });
  }
}

export async function runDepreciation(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  assetId?: string,
  allowedSubsidiaryIds?: string[],
  bookId?: string,
  scope?: RunDepreciationScope,
): Promise<RunDepreciationResult> {
  const scopedAssetIds =
    scope?.assetIds && scope.assetIds.length > 0
      ? [...new Set(scope.assetIds)]
      : assetId
        ? [assetId]
        : undefined;
  const result: RunDepreciationResult = {
    posted: 0,
    recorded: 0,
    recordedAmount: "0",
    skipped: 0,
    totalAmount: "0",
    entries: [],
    recordedEntries: [],
    skippedAssets: [],
    problemItems: [],
    problems: [],
    asOfDate,
    nextDue: null,
  };

  // Schedules project only months whose accounting periods exist; later
  // months are future gaps the builder leaves to be "mapped when their
  // periods are created" — but no other path rebuilds them, so a run after
  // month-end rollover would find no line and report "nothing due" while an
  // open period accrues. Extend each stale in-scope formula schedule first.
  // Extension is best-effort: a schedule that cannot extend keeps its lines
  // and the reason lands in problems, never a fatal error.
  const stale = (await db.execute<{
    asset_id: string;
    book_id: string;
    asset_number: string;
  }>(sql`
    select distinct s.asset_id, s.book_id, a.asset_number
      from depreciation_schedules s
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
     where s.org_id = ${orgId}
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and (s.method not in ('manual', 'units_of_production') or s.depreciation_method_id is not null)
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${uuidArray(allowedSubsidiaryIds)}::uuid[])` : sql``}
       ${scopedAssetIds ? sql`and a.id = any(${uuidArray(scopedAssetIds)}::uuid[])` : sql``}
       ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
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
  for (const s of stale.rows) {
    try {
      await buildSchedule(s.asset_id, orgId, actorId, s.book_id, allowedSubsidiaryIds);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${s.asset_number}: schedule extension skipped (${msg.slice(0, 120)})`);
    }
  }

  // Fingerprinted Confirm: the gate, the validation, and every
  // recognition/journal write run inside ONE outer transaction (see
  // runConfirmBatch). Locks are held from the fingerprint comparison
  // through the last posting, so no concurrent edit can slip between
  // validation and execution — and any refusal rolls back the whole batch
  // before the first write. The legacy immediate path below keeps its
  // historic per-line transactions and advisory skips.
  if (scope?.expectedLines) {
    await db.transaction((outer) =>
      runConfirmBatch(
        outer,
        orgId,
        asOfDate,
        actorId,
        allowedSubsidiaryIds ? [...allowedSubsidiaryIds] : undefined,
        bookId,
        { ...scope, expectedLines: scope.expectedLines ?? [] },
        result,
      ),
    );
  } else {

  // Due, unposted lines are only a candidate list. Account, dimension, and
  // other posting fields are reloaded under locks inside each line transaction.
  const due = (await db.execute<{
    line_id: string;
    asset_id: string;
    asset_number: string;
    period_name: string;
  }>(sql`
    select l.id as line_id, a.id as asset_id,
           a.asset_number, p.name as period_name
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
      join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
      join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
      join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
      join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
      join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.posted_amount is null
       and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
       and p.ends_on <= ${asOfDate}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
       ${scopedAssetIds ? sql`and a.id = any(${`{${scopedAssetIds.join(",")}}`}::uuid[])` : sql``}
       ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
       ${scope?.periodId ? sql`and l.period_id = ${scope.periodId}` : sql``}
       ${scope?.lineIds && scope.lineIds.length > 0 ? sql`and l.id = any(${`{${[...new Set(scope.lineIds)].join(",")}}`}::uuid[])` : sql``}
     order by a.asset_number, l.sequence`));

  for (const row of due.rows) {
    try {
      const posted = await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
        // Serialize against the authoritative asset edit path before reading
        // any account or dimension-bearing fields. The due query above is only
        // a candidate list; every posting input is reloaded after this lock.
        const assetLock = (await tx.execute<{ category_id: string; subsidiary_id: string }>(sql`
          select category_id, subsidiary_id
            from fixed_assets
           where id = ${row.asset_id} and org_id = ${orgId}
           for update`));
        const assetKey = assetLock.rows[0];
        if (!assetKey) return null;

        // Category account defaults are another authoritative source. Lock it
        // before resolving native asset overrides so a concurrent category edit
        // cannot be mixed with this asset snapshot.
        const categoryLock = (await tx.execute<{ id: string }>(sql`
          select id from asset_categories
           where id = ${assetKey.category_id} and org_id = ${orgId}
           for update`));
        if (!categoryLock.rows[0]) throw new DepreciationRefusalError("asset category not found");

        // Restriction validation depends on the complete subsidiary tree. Lock
        // that tree before loading it so parent/active-state edits cannot race
        // the account and dimension checks below.
        await tx.execute(sql`
          select id from subsidiaries
           where org_id = ${orgId}
           order by id
           for update`);

        // Claim the schedule line inside the posting transaction. Concurrent
        // runners serialize here and the loser observes posted_amount. The
        // asset/category/subsidiary locks above ensure every selected field is
        // the current committed configuration for this posting.
        const claimed = await reloadClaimLine(
          tx,
          orgId,
          row.line_id,
          asOfDate,
          allowedSubsidiaryIds ? [...allowedSubsidiaryIds] : undefined,
        );
        if (!claimed) return null;

        // Use the existing shared posting fence before the close check. A
        // reporting-only recognition must serialize with close even though
        // it will never reach je_guard. The storage guard takes it too.
        await tx.execute(sql`select period_posting_fence(${orgId}, ${claimed.period_id}, ${claimed.book_id})`);
        // One period gate: the shared assets+GL check replaces the raw
        // period_module_is_closed projection. Discovery stays advisory — a
        // closed line is skipped, not fatal — and source-owned imported
        // locks skip exactly like user locks.
        if (!(await arePeriodModulesOpen(tx, {
          orgId,
          periodId: claimed.period_id,
          bookId: claimed.book_id,
          subsidiaryIds: [claimed.subsidiary_id],
          modules: ["assets"],
        }))) {
          return {
            entryId: null,
            amount: String(claimed.planned_amount),
            periodClosed: true,
            assetNumber: claimed.asset_number,
            periodName: claimed.period_name,
          };
        }

        const accounts = resolveAssetAccounts(
          {
            assetAccountId: claimed.asset_account,
            accumulatedDepreciationAccountId: claimed.asset_accum,
            depreciationExpenseAccountId: claimed.asset_expense,
          },
          {
            assetAccountId: claimed.cat_asset,
            accumulatedDepreciationAccountId: claimed.cat_accum,
            depreciationExpenseAccountId: claimed.cat_expense,
          },
        );

        // Lock every account and dimension that will be validated/read by the
        // journal insert. Their rows may carry subsidiary restrictions, so the
        // validation below must run after these locks on this same snapshot.
        const accountIds = [...new Set([
          accounts.assetAccountId,
          accounts.accumulatedDepreciationAccountId,
          accounts.depreciationExpenseAccountId,
        ])];
        await tx.execute(sql`
          select id from accounts
           where org_id = ${orgId}
             and id in (${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)})
           order by id
           for update`);

        const dimensions = [
          { table: "departments", id: claimed.department_id },
          { table: "projects", id: claimed.project_id },
          { table: "locations", id: claimed.location_id },
        ] as const;
        for (const dimension of dimensions) {
          if (!dimension.id) continue;
          await tx.execute(sql`
            select id from ${sql.raw(dimension.table)}
             where org_id = ${orgId} and id = ${dimension.id}
             for update`);
        }

        const subsidiaryContext = await loadSubsidiaryContext(tx, orgId);
        const planned = String(claimed.planned_amount);
        const lines = [
          { accountId: accounts.depreciationExpenseAccountId, amount: planned },
          { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(planned) },
        ];
        await validateSubsidiaryRestrictions(tx, {
          orgId,
          ctx: subsidiaryContext,
          docSubsidiaryId: claimed.subsidiary_id,
          lines: lines.map((line) => ({
            ...line,
            subsidiaryId: claimed.subsidiary_id,
            departmentId: claimed.department_id,
            projectId: claimed.project_id,
            locationId: claimed.location_id,
          })),
        });
        assertFinalKernelBalance(lines.map((line) => ({ amount: line.amount, subsidiaryId: claimed.subsidiary_id })));
        if (!claimed.posts_gl || isZero(planned)) {
          // The database validates the book and close policy, freezes the
          // non-GL timestamp and writes immutable before/after audit evidence.
          // Do not manufacture a journal merely to complete the subledger.
          const recorded = await tx.execute<{ id: string }>(sql`
            update depreciation_schedule_lines
               set posted_amount = ${planned},
                   non_gl_recognized_at = ${claimed.posts_gl ? sql`null` : sql`clock_timestamp()`},
                   updated_at = now(), updated_by = ${actorId}
             where id = ${row.line_id} and org_id = ${orgId} and posted_amount is null
             returning id`);
          if (recorded.rows.length !== 1) throw new Error("depreciation recognition did not record the claimed line; reload the schedule and retry");
          return {
            entryId: null,
            recorded: !claimed.posts_gl,
            amount: planned,
            assetId: row.asset_id,
            assetNumber: claimed.asset_number,
            periodName: claimed.period_name,
            lineId: row.line_id,
          };
        }

        // Corrections create another line for the same asset and period, so the
        // schedule-line id distinguishes every physical journal generation.
        // Every journal write routes through the ONE ledger API.
        const postedEntry = await postEntry(tx, {
          orgId,
          bookId: claimed.book_id,
          subsidiaryId: claimed.subsidiary_id,
          entryNumber: `DEP-${claimed.asset_number}-${claimed.period_name}-${claimed.line_id}`,
          postingDate: scope?.postingDate ?? claimed.period_ends_on,
          periodId: claimed.period_id,
          memo: `Depreciation — ${claimed.asset_name} (${claimed.period_name})`,
          origin: "depreciation",
          actorId,
          currency: claimed.base_currency,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount,
            departmentId: claimed.department_id,
            projectId: claimed.project_id,
            locationId: claimed.location_id,
            memo: `Depreciation ${claimed.period_name}`,
          })),
        });
        const eid = postedEntry.entryId;

        await tx.execute(sql`
          update depreciation_schedule_lines
             set posted_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id} and org_id = ${orgId}`);

        return {
          entryId: eid,
          amount: planned,
          assetId: row.asset_id,
          assetNumber: claimed.asset_number,
          periodName: claimed.period_name,
          lineId: row.line_id,
        };
      }));

      if (!posted) {
        result.skipped++;
        result.skippedAssets.push({
          assetNumber: row.asset_number,
          period: row.period_name,
          reason: "line already posted or removed",
        });
        continue;
      }
      if (posted.periodClosed) {
        result.skipped++;
        result.skippedAssets.push({
          assetNumber: posted.assetNumber,
          period: posted.periodName,
          reason: "GL period closed",
        });
        result.problems.push(`${posted.assetNumber} ${posted.periodName}: GL period closed`);
        result.problemItems.push({
          assetNumber: posted.assetNumber,
          period: posted.periodName,
          message: "GL period closed",
          assetId: row.asset_id,
          lineId: row.line_id,
        });
        continue;
      }
      if ("recorded" in posted && posted.recorded) {
        result.recorded++;
        result.recordedAmount = add(result.recordedAmount, posted.amount);
        result.recordedEntries.push({
          assetId: posted.assetId,
          assetNumber: posted.assetNumber,
          period: posted.periodName,
          amount: posted.amount,
          lineId: posted.lineId,
        });
        continue;
      }
      if (!posted.entryId) {
        result.skipped++;
        result.skippedAssets.push({
          assetNumber: posted.assetNumber,
          period: posted.periodName,
          reason: "line vanished before claim",
        });
        continue;
      }
      result.posted++;
      result.totalAmount = add(result.totalAmount, posted.amount);
      result.entries.push({
        assetId: posted.assetId,
        assetNumber: posted.assetNumber,
        period: posted.periodName,
        amount: posted.amount,
        entryId: posted.entryId,
        lineId: posted.lineId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${row.asset_number} ${row.period_name}: ${msg.slice(0, 120)}`);
      result.problemItems.push({
        assetNumber: row.asset_number,
        period: row.period_name,
        message: msg.slice(0, 120),
        assetId: row.asset_id,
        lineId: row.line_id,
      });
    }
  }
  }

  // A run that posts nothing must still say what it ran for and what is
  // next: a mid-period run otherwise answers all-zero counters with an empty
  // problems list while a planned line waits in the open period (F-t07-005).
  // Same scope as the due list above, minus the ended-period filter.
  if (result.posted === 0 && result.recorded === 0) {
    const next = (await db.execute<{
      asset_number: string;
      period_name: string;
      ends_on: string;
      amount: string;
    }>(sql`
      select a.asset_number, p.name as period_name, p.ends_on::text as ends_on,
             l.planned_amount::text as amount
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join accounting_books bk on bk.id = s.book_id and bk.org_id = s.org_id and bk.is_active
        join fixed_assets a on a.id = s.asset_id and a.org_id = s.org_id
        join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
        join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
       where l.org_id = ${orgId}
         and l.posted_amount is null
         and a.status in ('in_service', 'fully_depreciated') /* POSTABLE_DEPRECIATION_STATUSES: drafts never own postable lines */
         ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
         ${scopedAssetIds ? sql`and a.id = any(${`{${scopedAssetIds.join(",")}}`}::uuid[])` : sql``}
         ${bookId ? sql`and s.book_id = ${bookId}` : sql``}
         ${scope?.periodId ? sql`and l.period_id = ${scope.periodId}` : sql``}
       order by p.ends_on, a.asset_number, l.sequence
       limit 1`));
    const upcoming = next.rows[0];
    if (upcoming) {
      result.nextDue = {
        assetNumber: upcoming.asset_number,
        period: upcoming.period_name,
        endsOn: upcoming.ends_on,
        amount: upcoming.amount,
      };
    }
  }

  if (scopedAssetIds) {
    for (const id of scopedAssetIds) {
      await db.transaction(tx => reconcileAssetDepreciationStatusWithRunner(tx, orgId, actorId, id, allowedSubsidiaryIds));
    }
  } else {
    await db.transaction(tx => reconcileAssetDepreciationStatusWithRunner(tx, orgId, actorId, assetId, allowedSubsidiaryIds));
  }

  return result;
}
