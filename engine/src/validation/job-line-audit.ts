/**
 * Reconcile EVERY job-linked transaction line against the source system.
 *
 * The goal is line-by-line parity for every job: each line the source system
 * carries against a job must exist in OpenBooks, on the right project, with the
 * same amount, the same billability, and the same ticket/markup provenance —
 * because the project-billing engine can only rebuild an invoice from what it
 * can see. A line that imported with is_billable false is invisible to billing
 * even though it is sitting right there in the ledger.
 *
 * Pulls the source lines in chunks (the bridge pages at 1,000 rows and large
 * aggregates exceed governance), caches them, then compares.
 *
 * Usage: npx tsx --conditions=react-server src/validation/job-line-audit.ts [--refresh]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { sourceClient } from "../sync/source-client.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const CACHE = "/tmp/ns-job-lines.json";
const REFRESH = process.argv.includes("--refresh");

/** Source transaction types that can carry job cost or job revenue. */
const TYPES = ["VendBill", "ExpRept", "CustInvc", "SalesOrd", "PurchOrd", "VendCred", "CustCred", "Check", "CardChrg", "Journal"];

interface SrcLine {
  txn: string; line: string; type: string; amount: string | null;
  billable: boolean; ticket: string | null; markup: string | null; mult: string | null;
}

async function retry<T>(fn: () => Promise<T>, n = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection|governance/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}

async function fetchSourceLines(): Promise<SrcLine[]> {
  if (!REFRESH && existsSync(CACHE)) {
    const cached = JSON.parse(readFileSync(CACHE, "utf8")) as SrcLine[];
    console.log(`source lines: ${cached.length} (cached — pass --refresh to re-pull)`);
    return cached;
  }
  const client = sourceClient();
  const out: SrcLine[] = [];
  for (const type of TYPES) {
    // Chunked by transaction id: a single unbounded scan trips governance.
    const bounds = (await retry(() => client.query<{ lo: string; hi: string }>(
      `select min(id) lo, max(id) hi from transaction where type = '${type}'`))) as any;
    const lo = Number(bounds[0]?.lo ?? 0), hi = Number(bounds[0]?.hi ?? 0);
    if (!hi) { console.log(`  ${type}: none`); continue; }
    const STEP = 50_000;
    let got = 0;
    for (let start = lo; start <= hi; start += STEP) {
      const rows = await retry(() => client.query<Record<string, string>>(`
        select tl.transaction txn, tl.id line, tl.netamount amount, tl.isbillable billable,
               tl.custcol_bit_timesheet_number ticket, tl.custcol_bit_markup markup,
               tl.custcol_bit_cost_multiplier mult
          from transactionline tl
         where tl.entity in (select id from job)
           and tl.transaction in (select id from transaction where type = '${type}')
           and tl.transaction >= ${start} and tl.transaction < ${start + STEP}`));
      for (const r of rows) {
        out.push({
          txn: String(r.txn), line: String(r.line), type,
          amount: r.amount ?? null,
          billable: String(r.billable ?? "").toUpperCase() === "T",
          ticket: r.ticket ?? null, markup: r.markup ?? null, mult: r.mult ?? null,
        });
      }
      got += rows.length;
    }
    console.log(`  ${type}: ${got}`);
  }
  writeFileSync(CACHE, JSON.stringify(out));
  console.log(`source lines: ${out.length} -> ${CACHE}`);
  return out;
}

(async () => {
  const env = (await retry(() => db.execute(sql`select env_kind from orgs where id = ${ORG}`))) as any;
  if (env.rows[0]?.env_kind !== "sandbox") throw new Error("refusing: target org is not a sandbox");

  const src = await fetchSourceLines();
  const byTxn = new Map<string, SrcLine[]>();
  for (const l of src) byTxn.set(l.txn, [...(byTxn.get(l.txn) ?? []), l]);

  const ours = (await retry(() => db.execute(sql`
    select d.custom->>'nsId' as txn, d.kind, count(dl.id)::int lines,
           count(dl.id) filter (where dl.project_id is not null)::int with_project,
           count(dl.id) filter (where dl.is_billable)::int billable,
           count(dl.id) filter (where dl.field_ticket_id is not null)::int ticketed
      from documents d join document_lines dl on dl.document_id = d.id
     where d.org_id = ${ORG} and d.custom->>'nsId' is not null
     group by 1, 2`))) as any;
  const mine = new Map<string, any>();
  for (const r of ours.rows as any[]) mine.set(String(r.txn), r);

  let missingDoc = 0, shortLines = 0, notBillable = 0, notTicketed = 0, notProjected = 0;
  const gaps: any[] = [];
  for (const [txn, lines] of byTxn) {
    const have = mine.get(txn);
    if (!have) { missingDoc++; gaps.push({ txn, type: lines[0]!.type, issue: "document not imported", lines: lines.length }); continue; }
    const wantBillable = lines.filter((l) => l.billable).length;
    const wantTicket = lines.filter((l) => l.ticket).length;
    if (have.lines < lines.length) { shortLines++; gaps.push({ txn, type: lines[0]!.type, issue: "fewer lines", want: lines.length, got: have.lines }); }
    if (have.billable < wantBillable) { notBillable++; gaps.push({ txn, type: lines[0]!.type, issue: "billability lost", want: wantBillable, got: have.billable }); }
    if (have.ticketed < wantTicket) { notTicketed++; gaps.push({ txn, type: lines[0]!.type, issue: "ticket link lost", want: wantTicket, got: have.ticketed }); }
    if (have.with_project < lines.length) { notProjected++; gaps.push({ txn, type: lines[0]!.type, issue: "project link lost", want: lines.length, got: have.with_project }); }
  }

  console.log(`\n--- ${byTxn.size} source transactions carrying job lines ---`);
  console.log(`  document not imported : ${missingDoc}`);
  console.log(`  fewer lines           : ${shortLines}`);
  console.log(`  billability lost      : ${notBillable}`);
  console.log(`  ticket link lost      : ${notTicketed}`);
  console.log(`  project link lost     : ${notProjected}`);

  const byType: Record<string, Record<string, number>> = {};
  for (const g of gaps) ((byType[g.type] ??= {})[g.issue] = (byType[g.type]?.[g.issue] ?? 0) + 1);
  console.log("\nby transaction type:");
  for (const [t, issues] of Object.entries(byType)) {
    console.log(`  ${t.padEnd(10)} ${Object.entries(issues).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  writeFileSync("/tmp/job-line-gaps.json", JSON.stringify(gaps));
  console.log(`\n${gaps.length} gaps -> /tmp/job-line-gaps.json`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c: any = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 200));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
