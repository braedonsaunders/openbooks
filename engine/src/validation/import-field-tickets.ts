/**
 * Import billable timesheets (field tickets) exactly from a connector export.
 *
 * A field ticket is the crew's week on a job — approved, customer-signed, and in
 * many businesses the actual UNIT OF BILLING. Without them a migrated tenant can
 * neither reproduce how it bills nor produce the backup its customers expect.
 *
 * Reads two explicit tab-separated exports (no live source connection):
 *   --headers  id, TSNumber, JobID, EmpID, CustomerID, PPEBegin, PPEEnd,
 *                     Billed, FinalTimesheet, ApprovalStatus, ForemanID, PO, Description
 *   --rows     TimesheetID, EmpID, ItemId, Shortform, then 7 days x
 *                     (Reg, Over, Double)
 *
 * Creates one `field_ticket` document plus its native `field_tickets` header.
 * It deliberately does not infer time lineage from coincident project/person/
 * date/hour values. Exact line attachment is a separate source-identity
 * reconciliation (`link-field-ticket-time-by-source.ts`).
 *
 * Usage: npx tsx src/validation/import-field-tickets.ts
 *   --org=<uuid> --headers=/path/headers.tsv --rows=/path/rows.tsv
 *   --source-system=<stable connector id>
 *   [--out=/path/report.json] [--apply --production]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, ...value] = arg.slice(2).split("=");
      return [key!, value.length ? value.join("=") : "true"];
    }),
);
const ORG =
  args.get("org") ??
  process.env.TARGET_ORG ??
  process.env.SANDBOX_ORG ??
  (() => { throw new Error("--org, TARGET_ORG, or SANDBOX_ORG is required"); })();
const APPLY = args.get("apply") === "true";
const HEADERS = args.get("headers") ?? "/tmp/ft-head.tsv";
const ROWS = args.get("rows") ?? "/tmp/ft-rows.tsv";
const OUT = args.get("out") ?? null;
const SOURCE_SYSTEM = args.get("source-system")?.trim();
if (!SOURCE_SYSTEM || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(SOURCE_SYSTEM)) {
  throw new Error("--source-system is required and must be a stable connector id");
}
if (!existsSync(HEADERS) || !existsSync(ROWS)) {
  throw new Error("--headers and --rows source artifacts are required");
}

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
  sourceId: string; number: string; jobRef: string; empRef: string; customerRef: string;
  begin: string; end: string; billed: boolean; final: boolean; approval: string;
  foremanRef: string; po: string | null; description: string | null;
}
interface Row { ticketId: string; empRef: string; itemRef: string; hours: { day: number; kind: string; h: number }[] }

const parseTickets = (): Ticket[] =>
  readFileSync(HEADERS, "utf8").split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 13 && /^\d+$/.test(c[0]!))
    .map((c) => ({
      sourceId: c[0]!, number: c[1]!, jobRef: c[2]!, empRef: c[3]!, customerRef: c[4]!,
      begin: c[5]!, end: c[6]!, billed: c[7] === "Yes", final: c[8] === "Yes", approval: c[9]!,
      foremanRef: c[10]!, po: c[11] === "NULL" ? null : c[11]!, description: (c[12] ?? "").trim() || null,
    }));

const parseRows = (): Row[] =>
  readFileSync(ROWS, "utf8").split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 25 && /^\d+$/.test(c[0]!))
    .map((c) => {
      const hours: Row["hours"] = [];
      for (let d = 0; d < 7; d++) {
        const base = 4 + d * 3;
        for (const [off, kind] of [[0, "Regular"], [1, "Over"], [2, "Double"]] as const) {
          const h = Number(c[base + off] ?? 0);
          if (h > 0) hours.push({ day: d, kind, h });
        }
      }
      return { ticketId: c[0]!, empRef: c[1]!, itemRef: c[2]!, hours };
    });

(async () => {
  await resolveTargetOrg(ORG);

  const tickets = parseTickets();
  const rows = parseRows();
  const byTicket = new Map<string, Row[]>();
  for (const r of rows) { const l = byTicket.get(r.ticketId) ?? []; l.push(r); byTicket.set(r.ticketId, l); }
  console.log(`export: ${tickets.length} tickets, ${rows.length} crew rows, ${rows.reduce((t, r) => t + r.hours.length, 0)} day/type hour cells`);

  const map = async (table: string) => {
    const r = (await retry(() => db.execute(sql.raw(
      `select custom->>'nsId' k, id from "${table}" where org_id = '${ORG}' and custom->>'nsId' is not null`))));
    return new Map<string, string>((r.rows).map((x) => [String(x.k), String(x.id)]));
  };
  const projects = await map("projects");
  const parties = await map("parties");
  const actor = ((await retry(() => db.execute(sql`select id from users where org_id = ${ORG} order by created_at limit 1`)))).rows[0]?.id;
  const org = ((await retry(() => db.execute(sql`
    select base_currency from orgs where id = ${ORG}
  `)))).rows[0] as { base_currency?: string } | undefined;
  const baseCurrency = org?.base_currency?.trim();
  if (!baseCurrency) throw new Error("target organization has no base currency");

  // Preload the tickets already landed so a resumed run costs one query, not one per ticket.
  const existingTickets = new Map<string, string>(
    (((await retry(() => db.execute(sql`
      select document_number n, id from documents where org_id = ${ORG} and kind = 'field_ticket'`))) as any).rows as any[])
      .map((x) => [String(x.n), String(x.id)]),
  );
  let created = 0, nativeCreated = 0, noProject = 0, existing = 0;
  for (const t of tickets) {
    const projectId = projects.get(t.jobRef) ?? null;
    if (!projectId) { noProject++; continue; }
    if (!APPLY) continue;

    let ticketDocId: string | undefined = existingTickets.get(t.number);
    if (ticketDocId) existing++;
    else {
      const sourceMetadata = {
        source: {
          system: SOURCE_SYSTEM,
          externalId: t.sourceId,
          number: t.number,
          jobRef: t.jobRef,
          empRef: t.empRef,
          foremanRef: t.foremanRef,
          periodBegin: t.begin,
          periodEnd: t.end,
          billed: t.billed,
          finalTicket: t.final,
          approval: t.approval,
        },
      };
      ticketDocId = await retry(() => withOrg(ORG, async () => {
        const ins = (await db.execute(sql`
          insert into documents (org_id, kind, document_number, party_id, project_id, document_date, currency,
                                 status, memo, subtotal, tax_total, total, reference_number, created_by, custom)
          values (${ORG}, 'field_ticket', ${t.number}, ${parties.get(t.customerRef) ?? null}, ${projectId},
                  ${t.end}, ${baseCurrency}, ${t.approval === "Yes" ? "approved" : "draft"}, ${t.description},
                  '0', '0', '0', ${t.po}, ${actor},
                  ${JSON.stringify(sourceMetadata)}::jsonb)
          returning id`)) as any;
        await db.execute(sql`
          insert into field_tickets
            (document_id, org_id, period, period_start, period_end,
             foreman_party_id, created_by, updated_by)
          values (${ins.rows[0].id}, ${ORG}, 'weekly', ${t.begin}, ${t.end},
                  ${parties.get(t.foremanRef) ?? null}, ${actor}, ${actor})
        `);
        return String(ins.rows[0].id);
      }));
      existingTickets.set(t.number, ticketDocId!);
      created++;
    }

    const native = await retry(() => db.execute(sql`
      insert into field_tickets
        (document_id, org_id, period, period_start, period_end,
         foreman_party_id, created_by, updated_by)
      values (${ticketDocId}, ${ORG}, 'weekly', ${t.begin}, ${t.end},
              ${parties.get(t.foremanRef) ?? null}, ${actor}, ${actor})
      on conflict (document_id) do nothing
      returning document_id
    `));
    nativeCreated += native.rows.length;
  }
  const report = {
    mode: APPLY ? "apply" : "plan",
    source: {
      ticketHeaders: tickets.length,
      crewRows: rows.length,
      nonzeroHourCells: rows.reduce((total, row) => total + row.hours.length, 0),
    },
    result: { created, nativeCreated, existing, unmappedProjects: noProject },
  };
  console.log(`${APPLY ? "imported" : "PLAN"}: tickets created ${created}, native headers added ${nativeCreated}, already present ${existing}, unmapped job ${noProject}`);
  if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  if (APPLY) {
    const v = (await retry(() => db.execute(sql`
      select (select count(*) from documents where org_id = ${ORG} and kind = 'field_ticket')::int tickets,
             (select count(*) from field_tickets where org_id = ${ORG})::int native_headers`)));
    console.log("verify:", JSON.stringify(v.rows[0]));
  }
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 200));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
