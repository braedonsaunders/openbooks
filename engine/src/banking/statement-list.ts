/**
 * The imported statements of one bank account, one row per statement.
 *
 * Statements that share a statement date are separate imports, so every
 * query here keys on the statement id and orders by a unique tiebreak. A page
 * therefore never skips or repeats a same-date statement, and the import
 * timestamp is returned in full so the rows stay distinguishable.
 */
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import type { BankingContext } from "./banking-core";
import { requireBankAccountInScope } from "./reconcilable-account";

export type AccountStatementSort = "date" | "source" | "lines" | "imported";

export interface AccountStatementListInput {
  /** Matches the statement date or the source label. */
  q?: string;
  source?: string;
  sort: AccountStatementSort;
  dir: "asc" | "desc";
  page: number;
  perPage: number;
}

export type AccountStatementRow = {
  id: string;
  source: string;
  currency: string;
  statement_date: string;
  opening_balance: string | null;
  closing_balance: string | null;
  /** Full import timestamp; same-day imports differ by time. */
  imported_at: Date | string;
  line_count: number;
  unmatched_count: number;
  matched_count: number;
  excluded_count: number;
};

const MAX_PER_PAGE = 200;

const SORT_EXPR: Record<AccountStatementSort, SQL> = {
  date: sql`s.statement_date`,
  source: sql`s.source`,
  lines: sql`coalesce(lc.n, 0)`,
  imported: sql`s.imported_at`,
};

/**
 * List every statement imported to an account in scope. The page and its total
 * read one snapshot, so the pager and the rows always agree.
 */
export async function listAccountStatements(
  accountId: string,
  input: AccountStatementListInput,
  ctx: BankingContext,
): Promise<{ rows: AccountStatementRow[]; total: number }> {
  return withOrgTransaction(
    ctx.orgId,
    async () => {
      await requireBankAccountInScope(db, ctx.orgId, accountId, ctx.allowedSubsidiaryIds);
      const search = input.q?.trim() ? `%${input.q.trim()}%` : null;
      const where = sql`s.account_id = ${accountId} and s.org_id = ${ctx.orgId}
      ${input.source ? sql` and s.source = ${input.source}` : sql``}
      ${search ? sql` and (s.statement_date::text ilike ${search} or s.source ilike ${search})` : sql``}`;
      const direction = input.dir === "asc" ? sql`asc` : sql`desc`;
      const perPage = Math.min(MAX_PER_PAGE, Math.max(1, Math.trunc(input.perPage)));
      const page = Math.max(1, Math.trunc(input.page));
      const rows = await db.execute<AccountStatementRow>(
        sql`
      select s.id, s.source,
             coalesce((select line.currency from bank_statement_lines line
                        where line.statement_id = s.id and line.org_id = s.org_id
                        order by line.line_number limit 1), a.currency_restriction) as currency,
             s.statement_date::text as statement_date,
             s.opening_balance::text as opening_balance, s.closing_balance::text as closing_balance,
             s.imported_at,
             coalesce(lc.n, 0)::int as line_count, coalesce(lc.unmatched, 0)::int as unmatched_count,
             coalesce(lc.matched, 0)::int as matched_count, coalesce(lc.excluded, 0)::int as excluded_count
        from bank_statements s
        join accounts a on a.id = s.account_id and a.org_id = s.org_id
        left join lateral (
          select count(*) as n,
                 count(*) filter (where l.match_status = 'unmatched') as unmatched,
                 count(*) filter (where l.match_status = 'matched') as matched,
                 count(*) filter (where l.match_status = 'excluded') as excluded
            from bank_statement_lines l
           where l.statement_id = s.id and l.org_id = s.org_id) lc on true
       where ${where}
       order by ${SORT_EXPR[input.sort]} ${direction} nulls last, s.imported_at ${direction}, s.id ${direction}
       limit ${perPage} offset ${(page - 1) * perPage}
    `,
        "objects",
      );
      const count = await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n from bank_statements s where ${where}
    `,
        "objects",
      );
      return { rows, total: count[0]?.n ?? 0 };
    },
    { readOnly: true, isolationLevel: "REPEATABLE READ" },
  );
}
