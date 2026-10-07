import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/** Native draft → lines → posting order shared by benefit source and settlement fixtures. */
export async function seedBenefitIncentivePosting(
  h: { org: { orgId: string; bookId: string; subsidiaryId: string; periodId: string } },
  lines: ReadonlyArray<{ account: string; amount: string; department?: string | null; project?: string | null }>,
  opts: { date?: string; status?: string; currency?: string; subsidiary?: string; periodId?: string } = {},
): Promise<string> {
  const entry = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entry}, ${h.org.orgId}, ${h.org.bookId}, ${opts.subsidiary ?? h.org.subsidiaryId},
              ${entry}, ${opts.date ?? "2026-07-15"}::date, ${opts.periodId ?? h.org.periodId}, 'draft', 'manual')
    `);
    for (const [index, line] of lines.entries()) {
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency,
           txn_amount, fx_rate, department_id, project_id)
        values (${h.org.orgId}, ${entry}, ${index + 1}, ${line.account}, ${opts.subsidiary ?? h.org.subsidiaryId},
                ${line.amount}, ${opts.currency ?? "USD"}, ${line.amount}, 1,
                ${line.department ?? null}::uuid, ${line.project ?? null}::uuid)
      `);
    }
    if ((opts.status ?? "posted") === "posted") {
      await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`);
    }
  });
  return entry;
}
