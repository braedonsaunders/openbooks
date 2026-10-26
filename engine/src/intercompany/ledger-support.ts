import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { neg } from "../money/money.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { assertPeriodModulesOpen, CloseError, type CloseModule } from "../periods/period-policy.ts";
import { markEntryReversed, postEntry, type PostEntryResult } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { lookupSpotRate } from "../fx/spot-rate.ts";
import { IntercompanyError } from "./errors.ts";

/**
 * Ledger plumbing shared by the intercompany commands: the posting book and
 * period for a date, the open-period check with an actionable refusal, spot
 * rates with every missing rate named at once, and governed mirror reversals.
 */

export async function intercompanyPostingBook(runner: SqlExecutor, orgId: string): Promise<string> {
  const bookId = await activePostingPrimaryBookId(orgId, runner);
  if (!bookId) {
    throw new IntercompanyError(
      "there is no active primary accounting book; set one in Setup → Accounting → Accounting books",
    );
  }
  return bookId;
}

export async function intercompanyPostingPeriod(
  runner: SqlExecutor,
  orgId: string,
  date: string,
  subsidiaryId: string,
): Promise<string> {
  const period = await resolveCoveringPeriod(runner, orgId, date, subsidiaryId);
  if (!period) {
    throw new IntercompanyError(
      `no accounting period covers ${date}; open the period from Accounting → Periods or choose a date inside an existing period`,
    );
  }
  return period.id;
}

/** Refuse, naming the module and entity, when any affected entity's period is closed. */
export async function assertIntercompanyPeriodOpen(
  runner: SqlExecutor,
  input: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds: string[];
    modules: CloseModule[];
  },
): Promise<void> {
  try {
    await assertPeriodModulesOpen(runner, input);
  } catch (error) {
    if (error instanceof CloseError) throw new IntercompanyError(error.message);
    throw error;
  }
}

/** Check the effective posting period of every entity affected by a transaction. */
export async function assertIntercompanyPeriodsOpen(
  runner: SqlExecutor,
  input: {
    orgId: string;
    date: string;
    bookId: string;
    subsidiaryIds: string[];
    modules: CloseModule[];
  },
): Promise<void> {
  for (const subsidiaryId of [...new Set(input.subsidiaryIds)].sort()) {
    const periodId = await intercompanyPostingPeriod(runner, input.orgId, input.date, subsidiaryId);
    await assertIntercompanyPeriodOpen(runner, {
      orgId: input.orgId,
      periodId,
      bookId: input.bookId,
      subsidiaryIds: [subsidiaryId],
      modules: input.modules,
    });
  }
}

/** Translate posting refusals into intercompany refusals, keeping the cause. */
export function intercompanyPostingRefusal(error: unknown): never {
  if (error instanceof PostingError || error instanceof CloseError) {
    throw new IntercompanyError(error.message, 422, undefined, error);
  }
  throw error;
}

/**
 * Resolve spot rates from each currency to each functional currency on a
 * date. Missing rates refuse together, so the operator can enter them all.
 */
export async function resolveSpotRates(
  runner: SqlExecutor,
  orgId: string,
  date: string,
  needs: readonly { from: string; to: string }[],
): Promise<Map<string, string>> {
  const rates = new Map<string, string>();
  const missing: string[] = [];
  for (const need of needs) {
    const key = `${need.from}>${need.to}`;
    if (rates.has(key)) continue;
    if (need.from === need.to) {
      rates.set(key, "1");
      continue;
    }
    const rate = await lookupSpotRate(runner, orgId, need.from, need.to, date);
    if (!rate) missing.push(`${need.from}→${need.to}`);
    else rates.set(key, rate);
  }
  if (missing.length > 0) {
    throw new IntercompanyError(
      `no exchange rate on or before ${date} for ${missing.join(", ")}; enter them under Setup → Currency → Exchange Rates and try again`,
      422,
      { missingRates: missing },
    );
  }
  return rates;
}

/**
 * Post a governed reversal of one entry: every line mirrored with the same
 * rates, the original marked reversed, and every open-item settlement the
 * original made undone. Open items the original cleared become open again;
 * its own open-item lines settle against their mirrors so nothing dangles.
 */
export async function postMirrorReversal(
  runner: SqlExecutor,
  input: {
    orgId: string;
    entryId: string;
    entryNumber: string;
    postingDate: string;
    periodId: string;
    memo: string;
    actorId: string;
    idempotencyKey: string;
    custom: Record<string, unknown>;
    closeModules: CloseModule[];
  },
): Promise<string> {
  const original = (
    await runner.execute<{
      book_id: string;
      subsidiary_id: string;
      status: string;
      origin: string;
    }>(
      sql`
    select book_id, subsidiary_id, status, origin from journal_entries
     where org_id = ${input.orgId} and id = ${input.entryId}
     for update`,
      "objects",
    )
  )[0];
  if (!original) throw new IntercompanyError("the entry to reverse no longer exists", 409);
  if (original.status !== "posted")
    throw new IntercompanyError("only a posted entry can be reversed", 409);
  const lines = await runner.execute<{
    id: string;
    line_number: number;
    account_id: string;
    subsidiary_id: string;
    amount: string;
    currency: string;
    txn_amount: string;
    fx_rate: string;
    party_id: string | null;
    department_id: string | null;
    project_id: string | null;
    location_id: string | null;
    class_id: string | null;
    due_date: string | null;
    is_open_item: boolean;
  }>(
    sql`
    select id, line_number, account_id, subsidiary_id, amount::text as amount, currency,
           txn_amount::text as txn_amount, fx_rate::text as fx_rate, party_id, department_id,
           project_id, location_id, class_id, due_date::text as due_date, is_open_item
      from journal_lines
     where org_id = ${input.orgId} and entry_id = ${input.entryId}
     order by line_number`,
    "objects",
  );
  let posted: PostEntryResult;
  try {
    posted = await postEntry(runner, {
      orgId: input.orgId,
      bookId: original.book_id,
      subsidiaryId: original.subsidiary_id,
      entryNumber: input.entryNumber,
      postingDate: input.postingDate,
      periodId: input.periodId,
      memo: input.memo,
      // A reversal keeps its original's origin, so every reader that
      // classifies entries by origin treats the pair alike.
      origin: original.origin,
      reversesEntryId: input.entryId,
      custom: input.custom,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      closeModules: input.closeModules,
      lines: lines.map((line) => ({
        accountId: line.account_id,
        subsidiaryId: line.subsidiary_id,
        amount: neg(line.amount),
        currency: line.currency,
        txnAmount: neg(line.txn_amount),
        fxRate: line.fx_rate,
        memo: input.memo,
        partyId: line.party_id,
        departmentId: line.department_id,
        projectId: line.project_id,
        locationId: line.location_id,
        classId: line.class_id,
        dueDate: line.due_date,
        isOpenItem: line.is_open_item,
        lineNumber: line.line_number,
      })),
    });
  } catch (error) {
    intercompanyPostingRefusal(error);
  }
  await markEntryReversed(runner, {
    orgId: input.orgId,
    entryId: input.entryId,
    actorId: input.actorId,
  });
  const mirrorByNumber = new Map(posted.lines.map((line) => [line.lineNumber, line.id]));
  // Undo the settlements this entry made, then settle each of its own open
  // items against its mirror at the same values.
  await runner.execute(sql`
    update applications a
       set unapplied_at = now(), updated_at = now(), updated_by = ${input.actorId}
      from journal_lines l
     where a.org_id = ${input.orgId} and l.org_id = a.org_id and l.id = a.from_line_id
       and l.entry_id = ${input.entryId} and a.unapplied_at is null`);
  for (const line of lines) {
    if (!line.is_open_item) continue;
    const mirror = mirrorByNumber.get(line.line_number);
    if (!mirror) throw new IntercompanyError("the reversal is missing a mirrored line", 409);
    const amount = line.amount.replace("-", "");
    const txn = line.txn_amount.replace("-", "");
    await runner.execute(sql`
      insert into applications (org_id, from_line_id, to_line_id, amount, source_amount,
        source_transaction_amount, source_transaction_currency, target_transaction_amount,
        target_transaction_currency, settlement_rate, settlement_rate_source, settlement_rate_reference,
        applied_on, created_by, updated_by)
      values (${input.orgId}, ${line.id}, ${mirror}, ${amount}, ${amount}, ${txn}, ${line.currency},
        ${txn}, ${line.currency}, 1, 'same_currency', ${input.memo}, ${input.postingDate},
        ${input.actorId}, ${input.actorId})`);
  }
  return posted.entryId;
}
