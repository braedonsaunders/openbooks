/**
 * Import billable timesheets (field tickets) exactly, from a legacy export.
 *
 * A field ticket is the crew's week on a job — approved, customer-signed, and in
 * many businesses the actual UNIT OF BILLING. Without them a migrated tenant can
 * neither reproduce how it bills nor produce the backup its customers expect.
 *
 * Reads two tab-separated exports (no live connection to any legacy system):
 *   /tmp/ft-head.tsv  id, TSNumber, JobID, EmpID, CustomerID, PPEBegin, PPEEnd,
 *                     Billed, FinalTimesheet, ApprovalStatus, ForemanID, PO, Description
 *   /tmp/ft-rows.tsv  TimesheetID, EmpID, ItemId, Shortform, then 7 days x
 *                     (Reg, Over, Double)
 *
 * Creates one `field_ticket` document per ticket and LINKS the labor that is
 * already in the ledger (time_entries.field_ticket_id) rather than re-importing
 * hours, so the import can never double-count cost. Keys map through the ids the
 * rest of the migration already uses: projects/parties/items custom->>'nsId'.
 *
 * Usage: npx tsx src/validation/import-field-tickets.ts [--apply]
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function retry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

interface Ticket {
  legacyId: string; number: string; jobRef: string; empRef: string; customerRef: string;
  begin: string; end: string; billed: boolean; final: boolean; approval: string;
  foremanRef: string; po: string | null; description: string | null;
}
interface Row { ticketId: string; empRef: string; itemRef: string; hours: { day: number; kind: string; h: number }[] }

const parseTickets = (): Ticket[] =>
  readFileSync("/tmp/ft-head.tsv", "utf8").split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 13 && /^\d+$/.test(c[0]))
    .map((c) => ({
      legacyId: c[0], number: c[1], jobRef: c[2], empRef: c[3], customerRef: c[4],
      begin: c[5]!, end: c[6]!, billed: c[7] === "Yes", final: c[8] === "Yes", approval: c[9],
      foremanRef: c[10], po: c[11] === "NULL" ? null : c[11], description: (c[12] ?? "").trim() || null,
    }));

const parseRows = (): Row[] =>
  readFileSync("/tmp/ft-rows.tsv", "utf8").split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 25 && /^\d+$/.test(c[0]))
    .map((c) => {
      const hours: Row["hours"] = [];
      for (let d = 0; d < 7; d++) {
        const base = 4 + d * 3;
        for (const [off, kind] of [[0, "Regular"], [1, "Over"], [2, "Double"]] as const) {
          const h = Number(c[base + off] ?? 0);
          if (h > 0) hours.push({ day: d, kind, h });
        }
      }
      return { ticketId: c[0], empRef: c[1], itemRef: c[2], hours };
    });

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

  const tickets = parseTickets();
  const rows = parseRows();
  const byTicket = new Map<string, Row[]>();
  for (const r of rows) { const l = byTicket.get(r.ticketId) ?? []; l.push(r); byTicket.set(r.ticketId, l); }
  console.log(`export: ${tickets.length} tickets, ${rows.length} crew rows, ${rows.reduce((t, r) => t + r.hours.length, 0)} day/type hour cells`);

  const map = async (table: string) => {
    const r = (await retry(() => db.execute(sql.raw(
      `select custom->>'nsId' k, id from "${table}" where org_id = '${ORG}' and custom->>'nsId' is not null`)))) as any;
    return new Map<string, string>((r.rows as any[]).map((x) => [String(x.k), String(x.id)]));
  };
  const projects = await map("projects");
  const parties = await map("parties");
  const items = await map("items");
  const tt = (await retry(() => db.execute(sql`select id, name from time_types where org_id = ${ORG}`))) as any;
  const timeType = (kind: string): string | null => {
    const want = kind === "Regular" ? "regular time" : kind === "Over" ? "over time" : "double time";
    return (tt.rows as any[]).find((t) => String(t.name).toLowerCase() === want)?.id ?? null;
  };
  const actor = ((await retry(() => db.execute(sql`select id from users where org_id = ${ORG} order by created_at limit 1`))) as any).rows[0]?.id;

  // Preload the tickets already landed so a resumed run costs one query, not one per ticket.
  const existingTickets = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select document_number n, id from documents where org_id = ${ORG} and kind = 'field_ticket'`))) as any).rows as any[])
      .map((x) => [String(x.n), String(x.id)]),
  );
  let created = 0, linked = 0, noProject = 0, existing = 0;
  const pending: { ticket: string; project: string; emp: string; day: string; hours: number }[] = [];
  /** One statement links a whole batch: unnest the tuples and join on them. */
  const flush = async (batch: typeof pending): Promise<number> => {
    if (!batch.length) return 0;
    const r = (await retry(() => db.execute(sql`
      update time_entries te set field_ticket_id = v.ticket::uuid
        from (select unnest(${`{${batch.map((b) => b.ticket).join(",")}}`}::uuid[]) ticket,
                     unnest(${`{${batch.map((b) => b.project).join(",")}}`}::uuid[]) project,
                     unnest(${`{${batch.map((b) => b.emp).join(",")}}`}::uuid[]) emp,
                     unnest(${`{${batch.map((b) => b.day).join(",")}}`}::date[]) day,
                     unnest(${`{${batch.map((b) => b.hours).join(",")}}`}::numeric[]) hours) v
       where te.org_id = ${ORG} and te.field_ticket_id is null
         and te.project_id = v.project and te.employee_party_id = v.emp
         and te.worked_on = v.day and abs(te.hours - v.hours) < 0.005`))) as any;
    return r.rowCount ?? 0;
  };
  for (const t of tickets) {
    const projectId = projects.get(t.jobRef) ?? null;
    if (!projectId) { noProject++; continue; }
    if (!APPLY) continue;

    let ticketDocId: string | undefined = existingTickets.get(t.number);
    if (ticketDocId) existing++;
    else {
      const ins = (await retry(() => db.execute(sql`
        insert into documents (org_id, kind, document_number, party_id, project_id, document_date, currency,
                               status, memo, subtotal, tax_total, total, reference_number, created_by, custom)
        values (${ORG}, 'field_ticket', ${t.number}, ${parties.get(t.customerRef) ?? null}, ${projectId},
                ${t.end}, 'CAD', ${t.approval === "Yes" ? "approved" : "draft"}, ${t.description},
                '0', '0', '0', ${t.po}, ${actor},
                ${JSON.stringify({ legacy: { id: t.legacyId, number: t.number, jobRef: t.jobRef, empRef: t.empRef,
                  foremanRef: t.foremanRef, periodBegin: t.begin, periodEnd: t.end, billed: t.billed,
                  finalTicket: t.final, approval: t.approval } })}::jsonb)
        returning id`))) as any;
      ticketDocId = ins.rows[0].id;
      existingTickets.set(t.number, ticketDocId!);
      created++;
    }

    // Collect the (project, employee, day, hours) tuples this ticket covers; the
    // linking runs as ONE set-based statement per batch below. Doing it per hour
    // cell meant ~40k sequential round-trips, which saturated the database.
    for (const r of byTicket.get(t.legacyId) ?? []) {
      const empId = parties.get(r.empRef);
      if (!empId) continue;
      for (const h of r.hours) {
        pending.push({ ticket: ticketDocId!, project: projectId, emp: empId, day: addDays(t.begin, h.day), hours: h.h });
      }
    }
    if (pending.length >= 400) linked += await flush(pending.splice(0, pending.length));
  }
  linked += await flush(pending);
  console.log(`${APPLY ? "imported" : "PLAN"}: tickets created ${created}, already present ${existing}, unmapped job ${noProject}, time entries linked ${linked}`);
  if (APPLY) {
    const v = (await retry(() => db.execute(sql`
      select (select count(*) from documents where org_id = ${ORG} and kind = 'field_ticket')::int tickets,
             (select count(*) from time_entries where org_id = ${ORG} and field_ticket_id is not null)::int linked`))) as any;
    console.log("verify:", JSON.stringify(v.rows[0]));
  }
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
