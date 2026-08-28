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
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { sourceClient } from "../sync/source-client.ts";

const ORG = process.argv.find((a) => a.startsWith("--org="))?.split("=")[1]
  ?? process.env.RECONCILE_ORG ?? (process.env.PROD_ORG ?? (() => { throw new Error("PROD_ORG is required"); })());
const SINCE = process.argv.find((a) => a.startsWith("--since="))?.split("=")[1] ?? "2024-06-01";

/** P&L role, read from the account's type — a chart may say cogs or expense. */
const COST = ["cogs", "expense", "expense_other"];
const REVENUE = ["income", "revenue", "income_other"];

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: any = e; c; c = c.cause) chain.push(String(c?.message ?? ""));
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
  const [srcPl] = await retry(() => client.query<{ revenue: string; cost: string }>(`
    select sum(case when acct.accttype in ('Income','OthIncome') then -tal.amount else 0 end) revenue,
           sum(case when acct.accttype in ('COGS','Expense','OthExpense') then tal.amount else 0 end) cost
      from transactionaccountingline tal
      join transaction t on t.id = tal.transaction
      join account acct on acct.id = tal.account
      join accountingperiod ap on ap.id = t.postingperiod
     where tal.posting = 'T' and ap.isyear = 'F' and ap.startdate >= to_date('${SINCE}','YYYY-MM-DD')`));
  const [srcInv] = await retry(() => client.query<{ n: string; total: string }>(`
    select count(*) n, sum(t.foreigntotal) total from transaction t
      join accountingperiod ap on ap.id = t.postingperiod
     where t.type = 'CustInvc' and ap.startdate >= to_date('${SINCE}','YYYY-MM-DD')`));

  const ours = ((await retry(() => db.execute(sql`
    select coalesce(sum(-jl.amount) filter (where a.type = any(${`{${REVENUE.join(",")}}`}::text[])), 0)::text revenue,
           coalesce(sum(jl.amount) filter (where a.type = any(${`{${COST.join(",")}}`}::text[])), 0)::text cost
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${ORG} and je.posting_date >= ${SINCE}`))) as any).rows[0];
  const ourInv = ((await retry(() => db.execute(sql`
    select count(*)::int n, coalesce(sum(total), 0)::text total from documents
     where org_id = ${ORG} and kind = 'customer_invoice' and status = 'posted' and document_date >= ${SINCE}`))) as any).rows[0];

  console.log("LEDGER");
  line("revenue", Number(ours.revenue), Number(srcPl?.revenue ?? 0));
  line("cost", Number(ours.cost), Number(srcPl?.cost ?? 0));
  console.log("\nCUSTOMER INVOICES");
  line("count", Number(ourInv.n), Number(srcInv?.n ?? 0));
  line("total", Number(ourInv.total), Number(srcInv?.total ?? 0));

  // Job detail only exists after cutover; before it the history is year-end
  // summary journals with no project, so a job margin spanning both is meaningless.
  const job = ((await retry(() => db.execute(sql`
    select coalesce(sum(-jl.amount) filter (where a.type = any(${`{${REVENUE.join(",")}}`}::text[])), 0)::text revenue,
           coalesce(sum(jl.amount) filter (where a.type = any(${`{${COST.join(",")}}`}::text[])), 0)::text cost,
           coalesce(sum(jl.amount) filter (where je.origin = 'overhead_applied'), 0)::text overhead,
           count(distinct jl.project_id)::int projects
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${ORG} and jl.project_id is not null and je.posting_date >= ${SINCE}`))) as any).rows[0];
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
