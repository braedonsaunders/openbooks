/**
 * Reconcile an org's ledger against the source system it migrated from.
 *
 * Plausibility is not a test. A margin can look wrong because the business had
 * a bad year, and look right while half the revenue is missing — the only
 * question worth asking is whether OpenBooks agrees with the system of record.
 *
 * Reports revenue, cost and the invoice population side by side, and separates
 * the pre-cutover history (carried over as year-end summary journals, with no
 * project detail by design) from the transaction-level detail after it. Mixing
 * those two eras is what makes a healthy tenant look catastrophic.
 *
 * Usage: npx tsx --conditions=react-server src/validation/gl-reconcile.ts [--org=UUID] [--since=YYYY-MM-DD]
 *
 * --since may fall anywhere in a period: both sides filter on the actual
 * transaction date (source t.trandate against OpenBooks posting/document
 * dates), so a mid-period date covers the same population on both sides and
 * period-level P&L parity stays meaningful without snapping or refusing dates.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sourceClient } from "../sync/source-client.ts";
import { parseSince, sourceInvoiceQuery, sourcePlQuery } from "./gl-reconcile-queries.ts";

const ORG = process.argv.find((a) => a.startsWith("--org="))?.split("=")[1]
  ?? process.env.RECONCILE_ORG ?? (process.env.PROD_ORG ?? (() => { throw new Error("PROD_ORG is required"); })());
const SINCE = parseSince(process.argv.find((a) => a.startsWith("--since="))?.split("=")[1]);

/** P&L role, read from the account's type — a chart may say cogs or expense. */
const COST = ["cogs", "expense", "expense_other"];
const REVENUE = ["income", "revenue", "income_other"];

/** Aggregate P&L shape shared by the ledger and job-detail scans. */
interface LedgerTotals extends Record<string, unknown> {
  revenue: string;
  cost: string;
}

/** Document-population probe shape (count plus exact total). */
interface InvoiceTotals extends Record<string, unknown> {
  n: number;
  total: string;
}

/** Job-detail scan: ledger totals plus overhead and project count. */
interface JobTotals extends LedgerTotals {
  overhead: string;
  projects: number;
}

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: unknown = e; c; c = (c as { cause?: unknown })?.cause) {
        chain.push(String((c as { message?: unknown })?.message ?? ""));
      }
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const money = (v: unknown) => Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(2)}%`);
const line = (label: string, ours: number, theirs: number) => {
  const delta = ours - theirs;
  const flag = Math.abs(delta) <= Math.abs(theirs) * 0.005 ? "ok" : "DIFFERS";
  console.log(`  ${label.padEnd(22)} ours ${money(ours).padStart(16)}   source ${money(theirs).padStart(16)}   ${money(delta).padStart(15)}  ${pct(delta, theirs).padStart(8)}  ${flag}`);
};

(async () => {
  const org = ((await retry(() => db.execute(sql`select name, env_kind from orgs where id = ${ORG}`)))).rows[0];
  if (!org) throw new Error(`no such org: ${ORG}`);
  console.log(`${org.name} (${org.env_kind})  —  posting on/after ${SINCE}\n`);

  const client = sourceClient();
  const [srcPl] = await retry(() => client.query<{ revenue: string; cost: string }>(sourcePlQuery(SINCE)));
  const [srcInv] = await retry(() => client.query<{ n: string; total: string }>(sourceInvoiceQuery(SINCE)));

  const ours = ((await retry(() => db.execute<LedgerTotals>(sql`
    select coalesce(sum(-jl.amount) filter (where a.type = any(${`{${REVENUE.join(",")}}`}::text[])), 0)::text revenue,
           coalesce(sum(jl.amount) filter (where a.type = any(${`{${COST.join(",")}}`}::text[])), 0)::text cost
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${ORG} and je.posting_date >= ${SINCE}`)))).rows[0]!;
  const ourInv = ((await retry(() => db.execute<InvoiceTotals>(sql`
    select count(*)::int n, coalesce(sum(total), 0)::text total from documents
     where org_id = ${ORG} and kind = 'customer_invoice' and status = 'posted' and document_date >= ${SINCE}`)))).rows[0]!;

  console.log("LEDGER");
  line("revenue", Number(ours.revenue), Number(srcPl?.revenue ?? 0));
  line("cost", Number(ours.cost), Number(srcPl?.cost ?? 0));
  console.log("\nCUSTOMER INVOICES");
  line("count", Number(ourInv.n), Number(srcInv?.n ?? 0));
  line("total", Number(ourInv.total), Number(srcInv?.total ?? 0));

  // Job detail only exists after cutover; before it the history is year-end
  // summary journals with no project, so a job margin spanning both is meaningless.
  const job = ((await retry(() => db.execute<JobTotals>(sql`
    select coalesce(sum(-jl.amount) filter (where a.type = any(${`{${REVENUE.join(",")}}`}::text[])), 0)::text revenue,
           coalesce(sum(jl.amount) filter (where a.type = any(${`{${COST.join(",")}}`}::text[])), 0)::text cost,
           coalesce(sum(jl.amount) filter (where je.origin = 'overhead_applied'), 0)::text overhead,
           count(distinct jl.project_id)::int projects
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${ORG} and jl.project_id is not null and je.posting_date >= ${SINCE}`)))).rows[0]!;
  const jobRevenue = Number(job.revenue), jobCost = Number(job.cost), overhead = Number(job.overhead);
  console.log(`\nJOB-TAGGED (${job.projects} projects, detail exists only after cutover)`);
  console.log(`  revenue ${money(jobRevenue)}   cost ${money(jobCost)}   of which applied overhead ${money(overhead)}`);
  console.log(`  gross ${money(jobRevenue - jobCost)} (${pct(jobRevenue - jobCost, jobRevenue)})`);
  console.log(`  gross before applied overhead ${money(jobRevenue - jobCost + overhead)} (${pct(jobRevenue - jobCost + overhead, jobRevenue)})`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
