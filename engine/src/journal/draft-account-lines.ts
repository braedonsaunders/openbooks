import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Draft journal lines are not posted history: an account merge moves them to
 * the surviving account so the draft can still post. Posted and reversed
 * lines never move — their balance is transferred by a reclass entry and the
 * lines keep the account they were posted to.
 */
export async function countDraftAccountLines(
  executor: SqlExecutor,
  input: { orgId: string; accountId: string },
): Promise<number> {
  const row = (
    await executor.execute<{ n: number }>(
      sql`
    select count(*)::int as n
      from journal_lines jl
      join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
     where jl.org_id = ${input.orgId} and jl.account_id = ${input.accountId}
       and e.status = 'draft'`,
      "objects",
    )
  )[0];
  return Number(row?.n ?? 0);
}

/** Move draft journal lines from one account to another; returns the moved count. */
export async function repointDraftAccountLines(
  executor: SqlExecutor,
  input: { orgId: string; fromId: string; toId: string },
): Promise<number> {
  const moved = await executor.execute<{ id: string }>(
    sql`
    update journal_lines jl set account_id = ${input.toId}
     where jl.org_id = ${input.orgId} and jl.account_id = ${input.fromId}
       and exists (
         select 1 from journal_entries e
          where e.id = jl.entry_id and e.org_id = jl.org_id and e.status = 'draft'
       )
    returning jl.id`,
    "objects",
  );
  return moved.length;
}
