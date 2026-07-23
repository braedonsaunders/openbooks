import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { collectibleOpenItems } from "./activities/documents.ts";
import type { SimOrg } from "./world.ts";

/**
 * Read-only observation tools — how a persona sees the business before acting.
 * Everything returns plain JSON so the CLI can print it for a subagent to read.
 * None of these mutate; they are the "screens" the team looks at.
 */

async function rows<T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  const r = (await db.execute(q)) as unknown as { rows: T[] };
  return r.rows;
}

/** Draft vendor bills awaiting AP review (the AP inbox). */
export async function apInbox(world: SimOrg) {
  return rows(sql`
    select d.id, d.document_number as number, p.display_name as vendor, d.total, d.document_date, d.due_date,
           d.custom->'sim'->>'category' as category, d.custom->'sim'->>'dispute' as dispute
      from documents d join parties p on p.id = d.party_id
     where d.org_id = ${world.orgId} and d.kind = 'vendor_bill' and d.status = 'draft'
     order by d.due_date nulls last, d.total desc`);
}

/** Open (posted, unpaid) AP items by vendor — what a pay run would consider. */
export async function apOpen(world: SimOrg) {
  const out: { vendor: string; vendorId: string; lineId: string; documentId: string; open: string; dueDate: string | null }[] = [];
  for (const v of world.vendors) {
    const items = await collectibleOpenItems(world.orgId, v.id, "ap");
    for (const i of items.filter((x) => x.kind === "vendor_bill")) {
      out.push({ vendor: v.name, vendorId: v.id, lineId: i.lineId, documentId: i.documentId, open: i.open, dueDate: i.dueDate });
    }
  }
  return out.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
}

/** Draft customer invoices prepared and awaiting AR to issue (the AR inbox). */
export async function arInbox(world: SimOrg) {
  return rows(sql`
    select d.id, d.document_number as number, p.display_name as customer, d.total, d.document_date, d.due_date
      from documents d join parties p on p.id = d.party_id
     where d.org_id = ${world.orgId} and d.kind = 'customer_invoice' and d.status = 'draft'
     order by d.document_date, d.total desc`);
}

/** Incoming customer payments awaiting cash application, with suggested matches. */
export async function arReceipts(world: SimOrg) {
  return rows(sql`
    select d.id, d.document_number as number, p.display_name as customer,
           d.custom->'sim'->'suggest' as suggested
      from documents d join parties p on p.id = d.party_id
     where d.org_id = ${world.orgId} and d.kind = 'customer_payment' and d.status = 'draft'
     order by d.document_date`);
}

/** AR aging as of a date: open items bucketed by days past due. */
export async function arAging(world: SimOrg, asOf: string) {
  const out: { customer: string; number: string; open: string; dueDate: string | null; daysPastDue: number; bucket: string }[] = [];
  for (const c of world.customers) {
    const items = await collectibleOpenItems(world.orgId, c.id, "ar");
    for (const i of items.filter((x) => x.kind === "customer_invoice")) {
      const dpd = i.dueDate ? Math.floor((Date.parse(asOf) - Date.parse(i.dueDate)) / 86_400_000) : 0;
      const bucket = dpd <= 0 ? "current" : dpd <= 30 ? "1-30" : dpd <= 60 ? "31-60" : dpd <= 90 ? "61-90" : "90+";
      const docNum = await db.execute(sql`select document_number from documents where id = ${i.documentId}`);
      out.push({
        customer: c.name,
        number: ((docNum as unknown as { rows: { document_number: string }[] }).rows[0]?.document_number) ?? "",
        open: i.open,
        dueDate: i.dueDate,
        daysPastDue: dpd,
        bucket,
      });
    }
  }
  return out.sort((a, b) => b.daysPastDue - a.daysPastDue);
}

/** Trial balance as of a date (posted only). */
export async function trialBalance(world: SimOrg, asOf: string) {
  return rows(sql`
    select a.number, a.name, a.type, sum(l.amount)::text as balance
      from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.posting_date <= ${asOf}
     where a.org_id = ${world.orgId}
     group by a.number, a.name, a.type
     having abs(sum(l.amount)) >= 0.005
     order by a.number`);
}

/** Period lock status (GL module) across the calendar. */
export async function periodStatus(world: SimOrg) {
  return rows(sql`
    select p.name, p.starts_on, p.ends_on,
           coalesce((select pl.state from period_locks pl
                      where pl.period_id = p.id and pl.book_id = ${world.bookId} and pl.module = 'gl'
                      order by pl.updated_at desc limit 1), 'open') as gl_state
      from accounting_periods p
     where p.org_id = ${world.orgId}
     order by p.starts_on`);
}
