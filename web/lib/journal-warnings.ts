import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { ExactDecimal } from "./statement-format";

export interface PartylessControlLine {
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  amount: ExactDecimal;
}

/**
 * Posted entry legs on an AR/AP control account that name no customer or
 * vendor (F-t08-007). The posting itself stays legitimate — a party-less
 * control leg is real GL activity — but it sits outside every subledger, so
 * the post response must carry the warning instead of accepting the journal
 * silently. One row per leg, in line order.
 */
export async function partylessControlLines(orgId: string, entryId: string): Promise<PartylessControlLine[]> {
  const r = await db.execute<{
    account_id: string; account_number: string | null; account_name: string; amount: string;
  }>(sql`
    select a.id as account_id, a.number as account_number, a.name as account_name, l.amount::text as amount
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and l.entry_id = ${entryId}
       and a.type in ('asset_receivable', 'liability_payable')
       and l.party_id is null
     order by a.number nulls last, l.line_number
  `);
  return r.rows.map((row) => ({
    accountId: row.account_id,
    accountNumber: row.account_number,
    accountName: row.account_name,
    amount: row.amount as ExactDecimal,
  }));
}
