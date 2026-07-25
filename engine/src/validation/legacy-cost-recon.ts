/**
 * the tenant's JOB COST reconciliation — does OpenBooks carry the same cost on a job
 * as the legacy system, to the penny?
 *
 * Golden source: the legacy system's exported job-cost table (TotalJobCost / MarginDollars /
 * TotalJobPrice), which is what the business actually reports on. Its composition
 * (see the legacy invoice-assembly notes) is:
 *   actual bill/expense/PO cost + real labor cost from payroll journals
 *   + estimated (unposted) labor + labor burden.
 *
 * OpenBooks side: every posted, project-tagged journal line hitting a cost
 * account (COGS + the job-cost expense range), which is the ledger's own answer —
 * so a divergence is a real accounting difference, not a report definition.
 *
 * Cache the golden first:
 *   <export from the legacy system> \
 *     -Q "select JobID, TotalJobCost, TotalJobPrice, InvoicedToDate from job_costbilled"
 *   → /tmp/golden-cost.json  [{ job, cost, price, invoiced }]
 *
 * Usage: npx tsx src/validation/legacy-cost-recon.ts [--limit=N]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";

const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const GOLDEN_COST = "/tmp/golden-cost.json";
const JOBSET = "/tmp/jobset.json";
const OUT = "/tmp/cost-recon.json";
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "0");

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

const num = (v: unknown) => Number(v ?? 0);
const money = (v: number) => v.toFixed(2);

/** Posted, project-tagged cost per project, split by account class. */
async function openbooksCost(projectId: string) {
  const r = (await retry(() => db.execute(sql`
    select coalesce(sum(l.amount) filter (where a.type = 'cogs'), 0)::text as cogs,
           coalesce(sum(l.amount) filter (where a.type in ('expense','expense_other')), 0)::text as expense,
           coalesce(sum(l.amount) filter (where a.type in ('cogs','expense','expense_other')), 0)::text as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
      join accounts a on a.id = l.account_id
     where l.org_id = ${ORG} and l.project_id = ${projectId}`))) as any;
  const row = r.rows[0] ?? {};
  return { cogs: num(row.cogs), expense: num(row.expense), total: num(row.total) };
}

/** Same project resolution the replay harness uses (data-bearing twin). */
async function resolveProject(job: string): Promise<string | null> {
  const r = (await retry(() => db.execute(sql`
    select p.id,
           (select count(*) from time_entries te where te.project_id = p.id)
         + (select count(*) from document_lines dl where dl.project_id = p.id) as rows
      from projects p
     where p.org_id = ${ORG}
       and (p.code = ${job} or p.custom->>'nsId' = ${job}
            or p.name = (select name from projects where org_id = ${ORG} and code = ${job} limit 1))
     order by rows desc limit 1`))) as any;
  return r.rows[0]?.id ?? null;
}

(async () => {
  if (!existsSync(GOLDEN_COST)) throw new Error(`missing ${GOLDEN_COST} — export job_costbilled from the legacy system first`);
  const golden = JSON.parse(readFileSync(GOLDEN_COST, "utf8")) as { job: string; cost: string; price?: string }[];
  const byJob = new Map(golden.map((g) => [String(g.job), g]));
  const jobs = (JSON.parse(readFileSync(JOBSET, "utf8")) as { job: string }[]).map((j) => String(j.job));
  const list = LIMIT > 0 ? jobs.slice(0, LIMIT) : jobs;

  const results: any[] = [];
  console.log("job        legacy cost   OpenBooks cost         delta   pct");
  for (const job of list) {
    const g = byJob.get(job);
    if (!g) { results.push({ job, status: "no-golden" }); continue; }
    const projectId = await resolveProject(job);
    if (!projectId) { results.push({ job, status: "no-project" }); continue; }
    const ob = await openbooksCost(projectId);
    const gc = num(g.cost);
    const delta = ob.total - gc;
    const pct = gc === 0 ? 0 : (100 * delta) / gc;
    const status = Math.abs(delta) <= 0.005 ? "match" : "mismatch";
    results.push({ job, projectId, goldenCost: gc, obCost: ob.total, obCogs: ob.cogs, obExpense: ob.expense, delta, pct, status });
    writeFileSync(OUT, JSON.stringify(results, null, 1));
    console.log(
      `${job.padEnd(9)} ${money(gc).padStart(14)} ${money(ob.total).padStart(15)} ${money(delta).padStart(13)} ${pct.toFixed(1).padStart(6)}%` +
      (status === "match" ? "  OK" : ""),
    );
  }
  const scored = results.filter((r) => r.status === "match" || r.status === "mismatch");
  const s = (f: (r: any) => number) => scored.reduce((t, r) => t + f(r), 0);
  console.log(`\n--- cost reconciliation (${scored.length} jobs) ---`);
  console.log(`legacy cost ${money(s((r) => r.goldenCost))}`);
  console.log(`OpenBooks cost ${money(s((r) => r.obCost))}  delta ${money(s((r) => r.obCost) - s((r) => r.goldenCost))}`);
  console.log(`match ${scored.filter((r) => r.status === "match").length} | mismatch ${scored.filter((r) => r.status === "mismatch").length}`);
  console.log(`results -> ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
