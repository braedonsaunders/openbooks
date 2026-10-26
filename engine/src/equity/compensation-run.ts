/**
 * The stock compensation run of a legal entity through a date.
 *
 * For every option and RSU award the run measures the cumulative cost
 * recognized through the date (see compensation.ts), rounded to the
 * currency's minor unit, and posts the change since the award's previous
 * run line: Dr stock compensation expense / Cr paid-in capital
 * (share-based), or the reverse when forfeitures and voids reduce the
 * cumulative cost. Runs are sequential per legal entity: each run's date
 * follows the last one, and a run for a date already run returns that run
 * instead of posting again. A run with no change records a zero total and
 * posts nothing. Posting a run is a governed action an Equity action Flow
 * may require approval for. An award
 * stated in a foreign currency is expensed at its grant-date rate.
 *
 * The run also releases early-exercise deposits as restricted shares vest
 * (see restricted-stock.ts): for each certificate it measures the
 * cumulative deposit, grant-date value and par of its vested restricted
 * units and posts the change since its previous release line, in a second
 * entry: Dr early-exercise deposit, Dr paid-in capital (share-based)
 * / Cr share capital at par, Cr APIC. A voided certificate's releases
 * reverse in the next run.
 */
import { sql } from "drizzle-orm";
import type { CatalogRefusal } from "../platform/catalog-refusal.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { cumulativeCompensation, isCompensatory } from "./compensation.ts";
import { governEquityAction } from "./governance.ts";
import { EquityError, equityError, fig } from "./errors.ts";
import {
  assertEquityReadable,
  currencyExponent,
  loadLegalEntity,
  requireEquityReader,
  writeEquityAudit,
} from "./internal.ts";
import { restate } from "./fx.ts";
import {
  assertRunPeriodPostable,
  instrumentBalance,
  nextRunPeriodAfter,
  postEquityEntry,
  requirePolicyAccount,
  resolveAccountPolicy,
  runBlocked,
  runPeriodsToGenerate,
  type EquityLeg,
  type RunPeriodAfter,
} from "./posting.ts";
import { ledgerUnits } from "./quantities.ts";
import { earlyExerciseSource, measureRelease } from "./restricted-stock.ts";
import { formatLedger, newEquityId } from "./securities.ts";
import { loadEquityBook } from "./store.ts";
import { inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import type { EquityBook } from "./types.ts";
import { toUnits } from "../money/money.ts";

export interface CompensationLine {
  securityId: string;
  securityNumber: string;
  holderPartyId: string;
  kind: "option" | "rsu";
  cumulative: string;
  previous: string;
  period: string;
  /**
   * The part of the period's change recognized through the last posted run
   * but recorded after it (a backdated grant, a forfeiture dated before the
   * run): caught up by this run.
   */
  catchUp: string;
}

export interface ReleaseLine {
  securityId: string;
  securityNumber: string;
  holderPartyId: string;
  /** Restricted shares released to date. */
  shares: string;
  previousShares: string;
  /** Functional amounts released by this run. */
  deposit: string;
  reclass: string;
  par: string;
}

export interface CompensationPreview {
  subsidiaryId: string;
  throughDate: string;
  currency: string;
  lastRunThrough: string | null;
  total: string;
  lines: CompensationLine[];
  /** Early-exercise deposits the run would release to equity. */
  releaseTotal: string;
  releases: ReleaseLine[];
  /** Whether a run through the date would post anything. */
  due: boolean;
  /** The expense change recognized through the last posted run and caught up by this one. */
  catchUpTotal: string;
  /** Why the run cannot be posted through the date yet (its period has not ended, or is closed). */
  blocked: CatalogRefusal | null;
}

type PreviousLine = {
  security_id: string;
  cumulative_amount: string;
};

async function lastRun(
  orgId: string,
  subsidiaryId: string,
  onOrBefore?: string,
): Promise<{ id: string; through_date: string } | undefined> {
  return (
    await db.execute<{ id: string; through_date: string }>(
      sql`
    select id, through_date::text as through_date from equity_compensation_runs
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
       ${onOrBefore ? sql`and through_date <= ${onOrBefore}::date` : sql``}
     order by through_date desc limit 1`,
      "objects",
    )
  )[0];
}

/** The latest cumulative cost recorded for every award by runs through `through` (every run when absent). */
async function previousCumulative(
  orgId: string,
  subsidiaryId: string,
  through?: string,
): Promise<Map<string, bigint>> {
  const rows = await db.execute<PreviousLine>(
    sql`
    select distinct on (l.security_id) l.security_id, l.cumulative_amount::text as cumulative_amount
      from equity_compensation_run_lines l
      join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
     where l.org_id = ${orgId} and l.subsidiary_id = ${subsidiaryId}
       ${through ? sql`and r.through_date <= ${through}::date` : sql``}
     order by l.security_id, r.through_date desc`,
    "objects",
  );
  return new Map(rows.map((row) => [row.security_id, toUnits(row.cumulative_amount)]));
}

type MeasuredLine = CompensationLine & {
  units: { cumulative: bigint; previous: bigint; period: bigint; catchUp: bigint };
};

/**
 * Each award's cumulative cost through the date against the cost runs have
 * recorded for it. With the last run's date, the part of each change that
 * was recognized through that date (cost recorded after the run for the
 * periods it measured) is reported as the award's catch-up.
 */
function measure(
  book: EquityBook,
  throughDate: string,
  exponent: number,
  previous: ReadonlyMap<string, bigint>,
  lastRunThrough: string | null = null,
): { lines: MeasuredLine[]; total: bigint; catchUp: bigint } {
  const lines: MeasuredLine[] = [];
  let total = 0n;
  let catchUpTotal = 0n;
  for (const security of book.securities) {
    if (!isCompensatory(security) || security.issueDate > throughDate) continue;
    const cumulative = ledgerUnits(
      restate(cumulativeCompensation(book, security, throughDate), security.fxRate),
      exponent,
    );
    const before = previous.get(security.id) ?? 0n;
    const period = cumulative - before;
    if (cumulative === 0n && before === 0n) continue;
    const catchUp =
      lastRunThrough && lastRunThrough < throughDate && security.issueDate <= lastRunThrough
        ? ledgerUnits(
            restate(cumulativeCompensation(book, security, lastRunThrough), security.fxRate),
            exponent,
          ) - before
        : 0n;
    total += period;
    catchUpTotal += catchUp;
    lines.push({
      securityId: security.id,
      securityNumber: security.securityNumber,
      holderPartyId: security.holderPartyId,
      kind: security.kind as "option" | "rsu",
      cumulative: formatLedger(cumulative),
      previous: formatLedger(before),
      period: formatLedger(period),
      catchUp: formatLedger(catchUp),
      units: { cumulative, previous: before, period, catchUp },
    });
  }
  return { lines, total, catchUp: catchUpTotal };
}

interface PreviousRelease {
  shares: bigint;
  deposit: bigint;
  reclass: bigint;
  par: bigint;
}

/** The latest release recorded for every restricted certificate by runs through `through` (every run when absent). */
async function previousReleases(
  orgId: string,
  subsidiaryId: string,
  through?: string,
): Promise<Map<string, PreviousRelease>> {
  const rows = await db.execute<{
    security_id: string;
    cumulative_shares: string;
    cumulative_deposit: string;
    cumulative_reclass: string;
    cumulative_par: string;
  }>(
    sql`
    select distinct on (l.security_id) l.security_id, l.cumulative_shares::text as cumulative_shares, l.cumulative_deposit::text as cumulative_deposit,
           l.cumulative_reclass::text as cumulative_reclass, l.cumulative_par::text as cumulative_par
      from equity_compensation_run_releases l
      join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
     where l.org_id = ${orgId} and l.subsidiary_id = ${subsidiaryId}
       ${through ? sql`and r.through_date <= ${through}::date` : sql``}
     order by l.security_id, r.through_date desc`,
    "objects",
  );
  return new Map(
    rows.map((row) => [
      row.security_id,
      {
        shares: BigInt(row.cumulative_shares),
        deposit: toUnits(row.cumulative_deposit),
        reclass: toUnits(row.cumulative_reclass),
        par: toUnits(row.cumulative_par),
      },
    ]),
  );
}

type MeasuredRelease = ReleaseLine & {
  shareClassKind: "common" | "preferred";
  units: {
    cumulative: PreviousRelease;
    previous: PreviousRelease;
    period: Omit<PreviousRelease, "shares">;
  };
};

async function measureReleases(
  book: EquityBook,
  throughDate: string,
  functionalExponent: number,
  previous: ReadonlyMap<string, PreviousRelease>,
): Promise<{ lines: MeasuredRelease[]; total: bigint }> {
  const lines: MeasuredRelease[] = [];
  let total = 0n;
  for (const security of book.securities) {
    if (security.issueDate > throughDate) continue;
    const option = earlyExerciseSource(book, security);
    if (!option) continue;
    const shareClass = book.classes.find((row) => row.id === security.shareClassId)!;
    const exponent = await currencyExponent(db, security.currency);
    const measured = measureRelease(book, security, option, shareClass, throughDate, {
      certificate: exponent,
      functional: functionalExponent,
    });
    const before = previous.get(security.id) ?? { shares: 0n, deposit: 0n, reclass: 0n, par: 0n };
    const period = {
      deposit: measured.deposit - before.deposit,
      reclass: measured.reclass - before.reclass,
      par: measured.par - before.par,
    };
    if (
      period.deposit === 0n &&
      period.reclass === 0n &&
      period.par === 0n &&
      measured.shares === before.shares
    )
      continue;
    total += period.deposit + period.reclass;
    lines.push({
      securityId: security.id,
      securityNumber: security.securityNumber,
      holderPartyId: security.holderPartyId,
      shares: measured.shares.toString(),
      previousShares: before.shares.toString(),
      deposit: formatLedger(period.deposit),
      reclass: formatLedger(period.reclass),
      par: formatLedger(period.par),
      shareClassKind: shareClass.kind,
      units: {
        cumulative: {
          shares: measured.shares,
          deposit: measured.deposit,
          reclass: measured.reclass,
          par: measured.par,
        },
        previous: before,
        period,
      },
    });
  }
  return { lines, total };
}

/** A run dated before the latest posted run refuses: earlier periods are already measured. */
function backdated(
  last: { through_date: string } | undefined,
  throughDate: string,
): EquityError | null {
  if (!last || throughDate >= last.through_date) return null;
  return equityError(
    "compensationRunBackdated",
    { last: fig.date(last.through_date) },
    { field: "throughDate" },
  );
}

/** Whether a measured run posts anything: an expense change or a release line. */
const posts = (total: bigint, releases: { lines: unknown[] }): boolean =>
  total !== 0n || releases.lines.length > 0;

/**
 * What a run through the date would post, without posting it (equity.read).
 * A date before the latest posted run refuses as the run itself would.
 */
export async function previewCompensationRun(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  throughDate: string;
}): Promise<CompensationPreview> {
  const throughDate = requireDate(input.throughDate, "throughDate", "runDate");
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      const entity = await loadLegalEntity(db, input.orgId, input.subsidiaryId);
      const exponent = await currencyExponent(db, entity.currency);
      const book = await loadEquityBook(db, input.orgId, input.subsidiaryId);
      const last = await lastRun(input.orgId, input.subsidiaryId);
      const refusal = backdated(last, throughDate);
      if (refusal) throw refusal;
      const { lines, total, catchUp } = measure(
        book,
        throughDate,
        exponent,
        await previousCumulative(input.orgId, input.subsidiaryId),
        last?.through_date ?? null,
      );
      const releases = await measureReleases(
        book,
        throughDate,
        exponent,
        await previousReleases(input.orgId, input.subsidiaryId),
      );
      const alreadyRun = last?.through_date === throughDate;
      return {
        subsidiaryId: input.subsidiaryId,
        throughDate,
        currency: entity.currency,
        lastRunThrough: last?.through_date ?? null,
        total: formatLedger(total),
        lines: lines.map(({ units: _units, ...line }) => line),
        releaseTotal: formatLedger(releases.total),
        releases: releases.lines.map(({ units: _units, shareClassKind: _kind, ...line }) => line),
        due: !alreadyRun && posts(total, releases),
        catchUpTotal: formatLedger(catchUp),
        blocked: alreadyRun
          ? null
          : await runBlocked(input.orgId, input.subsidiaryId, throughDate, "compensation"),
      };
    },
    { isolationLevel: "REPEATABLE READ", readOnly: true },
  );
}

/**
 * The change a stock compensation run through each date would post: the
 * expense and the restricted stock releases, measured exactly as the run
 * measures them against the runs recorded through that date. A date the
 * runs have already reached has nothing due. It reads within the caller's
 * organization transaction and checks no actor, for the close checklist,
 * the equity overview and the runs view, which ask whether the run is
 * current rather than what it would post per award.
 */
export async function compensationRunChanges(
  orgId: string,
  subsidiaryId: string,
  throughDates: readonly string[],
): Promise<
  {
    throughDate: string;
    lastRunThrough: string | null;
    expense: string;
    releaseLines: number;
    currency: string;
  }[]
> {
  return withOrgTransaction(orgId, async () => {
    const entity = await loadLegalEntity(db, orgId, subsidiaryId);
    const exponent = await currencyExponent(db, entity.currency);
    const last = await lastRun(orgId, subsidiaryId);
    const out: {
      throughDate: string;
      lastRunThrough: string | null;
      expense: string;
      releaseLines: number;
      currency: string;
    }[] = [];
    let book: EquityBook | null = null;
    for (const throughDate of throughDates) {
      if (last && last.through_date >= throughDate) {
        out.push({
          throughDate,
          lastRunThrough: last.through_date,
          expense: "0.0000",
          releaseLines: 0,
          currency: entity.currency,
        });
        continue;
      }
      book ??= await loadEquityBook(db, orgId, subsidiaryId);
      const { total } = measure(
        book,
        throughDate,
        exponent,
        await previousCumulative(orgId, subsidiaryId, throughDate),
      );
      const releases = await measureReleases(
        book,
        throughDate,
        exponent,
        await previousReleases(orgId, subsidiaryId, throughDate),
      );
      out.push({
        throughDate,
        lastRunThrough: last?.through_date ?? null,
        expense: formatLedger(total),
        releaseLines: releases.lines.length,
        currency: entity.currency,
      });
    }
    return out;
  });
}

/** The change a stock compensation run through one date would post (see compensationRunChanges). */
export async function compensationRunChange(
  orgId: string,
  subsidiaryId: string,
  throughDate: string,
): Promise<{
  lastRunThrough: string | null;
  expense: string;
  releaseLines: number;
  currency: string;
}> {
  const [change] = await compensationRunChanges(orgId, subsidiaryId, [throughDate]);
  return change!;
}

/**
 * Stock compensation recognized through a posted run that no run has
 * posted: cost recorded after the run for the periods it measured (a grant
 * or issue dated before it, a forfeiture or void dated before it). The next
 * run, through the end of the period after the last one, posts it as a
 * catch-up; until then it is due here with its amount. As of a date, it is
 * measured through the latest run on or before that date, so nothing is due
 * for an award before the award exists. Null when there is no run yet or
 * nothing to catch up. Reads within the caller's organization transaction
 * and checks no actor (the overview and the runs view).
 */
export async function compensationCatchUp(
  orgId: string,
  subsidiaryId: string,
  asOf?: string,
): Promise<{
  recognizedThrough: string;
  expense: string;
  releaseLines: number;
  currency: string;
  awards: { securityId: string; securityNumber: string; amount: string }[];
  postsWith: RunPeriodAfter | null;
  generatePeriods: { calendarId: string; fiscalYear: number } | null;
} | null> {
  return withOrgTransaction(orgId, async () => {
    const latest = await lastRun(orgId, subsidiaryId);
    const last =
      latest && asOf && asOf < latest.through_date
        ? await lastRun(orgId, subsidiaryId, asOf)
        : latest;
    if (!latest || !last) return null;
    const entity = await loadLegalEntity(db, orgId, subsidiaryId);
    const exponent = await currencyExponent(db, entity.currency);
    const book = await loadEquityBook(db, orgId, subsidiaryId);
    const { lines, total } = measure(
      book,
      last.through_date,
      exponent,
      await previousCumulative(orgId, subsidiaryId, last.through_date),
    );
    const releases = await measureReleases(
      book,
      last.through_date,
      exponent,
      await previousReleases(orgId, subsidiaryId, last.through_date),
    );
    if (!posts(total, releases)) return null;
    const postsWith = await nextRunPeriodAfter(db, orgId, subsidiaryId, latest.through_date);
    return {
      recognizedThrough: last.through_date,
      expense: formatLedger(total),
      releaseLines: releases.lines.length,
      currency: entity.currency,
      awards: lines
        .filter((line) => line.units.period !== 0n)
        .map((line) => ({
          securityId: line.securityId,
          securityNumber: line.securityNumber,
          amount: line.period,
        })),
      postsWith,
      generatePeriods: postsWith
        ? null
        : await runPeriodsToGenerate(db, orgId, latest.through_date),
    };
  });
}

export interface CompensationRunResult {
  runId: string;
  throughDate: string;
  total: string;
  journalEntryId: string | null;
  lines: number;
  releaseAmount: string;
  releaseJournalEntryId: string | null;
  releases: number;
  replayed: boolean;
}

/** A run's outcome: posted (or already posted), or awaiting approval in Flows. */
export type GovernedRunResult<T> =
  | (T & { status: "applied"; requestId: string | null })
  | { status: "pending_approval"; requestId: string; throughDate: string };

/**
 * Post the stock compensation run through a date (equity.manage; a governed
 * action an Equity action Flow may require approval for).
 */
export async function postCompensationRun(
  input: EquityCommand & { subsidiaryId: string; throughDate: string },
): Promise<GovernedRunResult<CompensationRunResult>> {
  const throughDate = requireDate(input.throughDate, "throughDate", "runDate");
  // A run already posted for the date is returned as it stands; nothing is submitted again.
  const posted = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ id: string }>(
          sql`
    select id from equity_compensation_runs
     where org_id = ${input.orgId} and subsidiary_id = ${input.subsidiaryId} and through_date = ${throughDate}::date`,
          "objects",
        )
      ).length > 0,
  );
  if (posted) return { ...(await applyCompensationRun(input)), status: "applied", requestId: null };
  // A date whose period has not ended or is closed refuses before anything is submitted for approval.
  await withOrgTransaction(input.orgId, () =>
    assertRunPeriodPostable(db, input.orgId, input.subsidiaryId, throughDate, "compensation"),
  );
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: input.subsidiaryId,
      action: "compensation_run",
      subjectId: null,
      subjectLabel: `Stock compensation through ${throughDate}`,
      effectiveOn: throughDate,
      reason: null,
      summary: {},
      payload: { subsidiaryId: input.subsidiaryId, throughDate },
      idempotencyKey: null,
    },
    (actorId) => applyCompensationRun({ ...input, actorId }),
  );
  return outcome.result
    ? { ...outcome.result, status: "applied", requestId: outcome.requestId }
    : { status: "pending_approval", requestId: outcome.requestId, throughDate };
}

/** Apply the stock compensation run: the command its approval releases. */
export async function applyCompensationRun(
  input: EquityCommand & { subsidiaryId: string; throughDate: string },
): Promise<CompensationRunResult> {
  const throughDate = requireDate(input.throughDate, "throughDate", "runDate");
  return inEquityCommand(input, "equity.manage", async ({ book, currency, entityName }) => {
    const existing = (
      await db.execute<{
        id: string;
        total_amount: string;
        journal_entry_id: string | null;
        lines: number;
        release_amount: string;
        release_journal_entry_id: string | null;
        releases: number;
      }>(
        sql`
      select r.id, r.total_amount::text as total_amount, r.journal_entry_id, r.release_amount::text as release_amount, r.release_journal_entry_id,
             (select count(*)::int from equity_compensation_run_lines l where l.org_id = r.org_id and l.run_id = r.id) as lines,
             (select count(*)::int from equity_compensation_run_releases l where l.org_id = r.org_id and l.run_id = r.id) as releases
        from equity_compensation_runs r
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId} and r.through_date = ${throughDate}::date`,
        "objects",
      )
    )[0];
    if (existing) {
      return {
        runId: existing.id,
        throughDate,
        total: existing.total_amount,
        journalEntryId: existing.journal_entry_id,
        lines: existing.lines,
        releaseAmount: existing.release_amount,
        releaseJournalEntryId: existing.release_journal_entry_id,
        releases: existing.releases,
        replayed: true,
      };
    }
    const last = await lastRun(input.orgId, input.subsidiaryId);
    const refusal = backdated(last, throughDate);
    if (refusal) throw refusal;
    await assertRunPeriodPostable(db, input.orgId, input.subsidiaryId, throughDate, "compensation");
    const exponent = await currencyExponent(db, currency);
    const { lines, total } = measure(
      book,
      throughDate,
      exponent,
      await previousCumulative(input.orgId, input.subsidiaryId),
    );
    const releases = await measureReleases(
      book,
      throughDate,
      exponent,
      await previousReleases(input.orgId, input.subsidiaryId),
    );
    if (!posts(total, releases)) {
      throw last
        ? equityError(
            "compensationNothingDueSince",
            { date: fig.date(throughDate), last: fig.date(last.through_date) },
            { field: "throughDate" },
          )
        : equityError(
            "compensationNothingDue",
            { date: fig.date(throughDate) },
            { field: "throughDate" },
          );
    }
    const runId = await newEquityId(db);
    let journalEntryId: string | null = null;
    if (total !== 0n) {
      const policy = await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, throughDate);
      journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId,
        subsidiaryId: input.subsidiaryId,
        currency,
        postingDate: throughDate,
        entryNumberBase: `EQ-SBC-${throughDate}`,
        memo: `Stock compensation through ${throughDate} (${entityName})`,
        idempotencyKey: `equity:compensation-run:${input.subsidiaryId}:${throughDate}`,
        actorId: input.actorId,
        auditAction: "equity.compensation",
        auditChanges: { runId, throughDate },
        legs: [
          { accountId: policy.compensationExpenseAccountId, units: total },
          { accountId: policy.apicShareBasedAccountId, units: -total },
        ],
      });
    }
    let releaseJournalEntryId: string | null = null;
    if (
      releases.lines.some(
        (line) =>
          line.units.period.deposit !== 0n ||
          line.units.period.reclass !== 0n ||
          line.units.period.par !== 0n,
      )
    ) {
      const policy = await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, throughDate);
      const legs: EquityLeg[] = [];
      for (const line of releases.lines) {
        const { period } = line.units;
        const held = await instrumentBalance(
          db,
          input.orgId,
          input.subsidiaryId,
          line.securityId,
          "deposit",
        );
        const depositAccount =
          held.length === 1
            ? held[0]!.accountId
            : requirePolicyAccount(policy, "earlyExerciseDepositAccountId");
        legs.push(
          {
            accountId: depositAccount,
            units: period.deposit,
            balance: { securityId: line.securityId, role: "deposit" },
          },
          { accountId: policy.apicShareBasedAccountId, units: period.reclass },
          {
            accountId:
              line.shareClassKind === "preferred"
                ? policy.preferredStockAccountId
                : policy.commonStockAccountId,
            units: -period.par,
          },
          {
            accountId: policy.apicAccountId,
            units: -(period.deposit + period.reclass - period.par),
          },
        );
      }
      releaseJournalEntryId = await postEquityEntry(db, {
        orgId: input.orgId,
        subsidiaryId: input.subsidiaryId,
        currency,
        postingDate: throughDate,
        entryNumberBase: `EQ-RSR-${throughDate}`,
        memo: `Restricted stock released through ${throughDate} (${entityName})`,
        idempotencyKey: `equity:compensation-run:${input.subsidiaryId}:${throughDate}:release`,
        actorId: input.actorId,
        auditAction: "equity.release",
        auditChanges: { runId, throughDate },
        legs,
      });
    }
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into equity_compensation_runs (id, org_id, subsidiary_id, through_date, currency, total_amount, journal_entry_id, release_amount, release_journal_entry_id, created_by)
      values (${runId}, ${input.orgId}, ${input.subsidiaryId}, ${throughDate}::date, ${currency}, ${formatLedger(total)}::numeric, ${journalEntryId},
        ${formatLedger(releases.total)}::numeric, ${releaseJournalEntryId}, ${input.actorId})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw equityError("notSaved", { record: fig.choice("compensationRun") });
    const recorded = lines.filter(
      (line) => line.units.period !== 0n || line.units.cumulative !== 0n,
    );
    if (recorded.length > 0) {
      const values = recorded.map(
        (line) => sql`(${input.orgId}, ${input.subsidiaryId}, ${runId}, ${line.securityId},
        ${line.cumulative}::numeric, ${line.previous}::numeric, ${line.period}::numeric)`,
      );
      const written = await db.execute<{ id: string }>(
        sql`
        insert into equity_compensation_run_lines (org_id, subsidiary_id, run_id, security_id, cumulative_amount, previous_amount, period_amount)
        values ${sql.join(values, sql`, `)}
        returning id`,
        "objects",
      );
      if (written.length !== recorded.length) {
        throw equityError("notStoredCompletely", { record: fig.choice("compensationLines") });
      }
    }
    if (releases.lines.length > 0) {
      const values = releases.lines.map(
        (line) => sql`(${input.orgId}, ${input.subsidiaryId}, ${runId}, ${line.securityId},
        ${line.units.cumulative.shares.toString()}::bigint, ${line.units.previous.shares.toString()}::bigint,
        ${formatLedger(line.units.cumulative.deposit)}::numeric, ${formatLedger(line.units.period.deposit)}::numeric,
        ${formatLedger(line.units.cumulative.reclass)}::numeric, ${formatLedger(line.units.period.reclass)}::numeric,
        ${formatLedger(line.units.cumulative.par)}::numeric, ${formatLedger(line.units.period.par)}::numeric)`,
      );
      const written = await db.execute<{ id: string }>(
        sql`
        insert into equity_compensation_run_releases (org_id, subsidiary_id, run_id, security_id, cumulative_shares, previous_shares,
          cumulative_deposit, period_deposit, cumulative_reclass, period_reclass, cumulative_par, period_par)
        values ${sql.join(values, sql`, `)}
        returning id`,
        "objects",
      );
      if (written.length !== releases.lines.length) {
        throw equityError("notStoredCompletely", { record: fig.choice("releaseLines") });
      }
    }
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_compensation_runs",
      rowId: runId,
      action: "equity.compensation.run",
      actorId: input.actorId,
      changes: {
        before: { lastRunThrough: last?.through_date ?? null },
        after: {
          throughDate,
          total: formatLedger(total),
          lines: recorded.length,
          journalEntryId,
          releaseAmount: formatLedger(releases.total),
          releases: releases.lines.length,
          releaseJournalEntryId,
        },
      },
    });
    return {
      runId,
      throughDate,
      total: formatLedger(total),
      journalEntryId,
      lines: recorded.length,
      releaseAmount: formatLedger(releases.total),
      releaseJournalEntryId,
      releases: releases.lines.length,
      replayed: false,
    };
  });
}
