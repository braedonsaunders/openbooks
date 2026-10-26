import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { fromUnits } from "../money/money.ts";
import { postEntry } from "../journal/post-entry.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { posRefusal } from "./errors.ts";

/**
 * Drawer journals: a pay-in, a pay-out or a session's over/short. Each is
 * a balanced two-line entry between the register's cash account and one
 * counter account, posted through the one journal API with origin `pos`
 * and an exactly-once key, so a retried request returns the entry it
 * already posted instead of moving cash twice.
 */
export async function postDrawerJournal(
  runner: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    subsidiaryId: string;
    postingDate: string;
    entryNumberBase: string;
    memo: string;
    /** Positive debits the cash account (cash in); negative credits it. */
    cashUnits: bigint;
    cashAccountId: string;
    counterAccountId: string;
    locationId: string | null;
    idempotencyKey: string;
    auditChanges: Record<string, unknown>;
  },
): Promise<string> {
  if (input.cashUnits === 0n) throw new Error("a drawer journal needs a nonzero amount");
  const book = (
    await runner.execute<{ id: string }>(
      sql`
    select id from accounting_books
     where org_id = ${input.orgId} and is_primary and is_active and posts_gl
     limit 1 for share`,
      "objects",
    )
  )[0];
  const subsidiary = (
    await runner.execute<{ currency: string | null }>(
      sql`
    select nullif(trim(base_currency), '') as currency from subsidiaries
     where org_id = ${input.orgId} and id = ${input.subsidiaryId} and is_active
     for share`,
      "objects",
    )
  )[0];
  const period = await resolveCoveringPeriod(
    runner,
    input.orgId,
    input.postingDate,
    input.subsidiaryId,
  );
  if (!book || !subsidiary?.currency || !period) {
    throw posRefusal(
      "The drawer movement cannot post: the organization needs an active primary book, a legal entity with a currency and an accounting period covering today.",
      "register_misconfigured",
      422,
      "Configure the primary book, the register's legal entity currency and the accounting period for today, then retry.",
    );
  }
  const entryNumber = await nextFreeEntryNumber(runner, input.orgId, input.entryNumberBase);
  const amount = fromUnits(input.cashUnits);
  const counter = fromUnits(-input.cashUnits);
  const posted = await postEntry(runner, {
    orgId: input.orgId,
    bookId: book.id,
    subsidiaryId: input.subsidiaryId,
    entryNumber,
    postingDate: input.postingDate,
    periodId: period.id,
    memo: input.memo,
    origin: "pos",
    actorId: input.actorId,
    currency: subsidiary.currency,
    idempotencyKey: input.idempotencyKey,
    auditAction: "insert",
    auditChanges: input.auditChanges,
    lines: [
      { accountId: input.cashAccountId, amount, locationId: input.locationId, memo: input.memo },
      {
        accountId: input.counterAccountId,
        amount: counter,
        locationId: input.locationId,
        memo: input.memo,
      },
    ],
  });
  return posted.entryId;
}
