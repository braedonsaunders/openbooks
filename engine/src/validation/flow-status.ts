/**
 * How closely does this tenant's OpenBooks match its source system, end to end?
 *
 * Reports the parts of the flow separately, because "the invoices are right" and
 * "the job financials are right" are different claims and only one of them has
 * been under test.
 */
import { existsSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2500*(i+1)))}}throw l}
const one = async (q:any) => ((await retry(()=>db.execute(q))) as any).rows[0];

const src = existsSync("/tmp/ns-job-lines.json") ? JSON.parse(readFileSync("/tmp/ns-job-lines.json","utf8")) as any[] : [];
const gaps = existsSync("/tmp/job-line-gaps.json") ? JSON.parse(readFileSync("/tmp/job-line-gaps.json","utf8")) as any[] : [];
const txns = new Set(src.map((l)=>l.txn));

console.log("TRANSACTIONS (source job lines vs OpenBooks)");
console.log(`  source job lines            ${src.length}`);
console.log(`  source transactions          ${txns.size}`);
console.log(`  transactions with any gap    ${new Set(gaps.map((g)=>g.txn)).size}`);

const p = await one(sql`
  select count(*)::int projects,
         count(*) filter (where project_type_id is not null)::int typed,
         count(*) filter (where exists (select 1 from item_rate_book_assignments a
            where a.project_id = projects.id))::int with_rate_card
    from projects where org_id=${ORG}`);
console.log("\nPROJECTS");
console.log(`  projects ${p.projects}, typed ${p.typed}, linked to a rate card ${p.with_rate_card}`);

const c = await one(sql`
  select count(*)::int lines,
         count(*) filter (where is_billable)::int billable,
         count(*) filter (where field_ticket_id is not null)::int ticketed,
         count(*) filter (where markup_percent is not null)::int with_markup,
         count(*) filter (where custom->>'sourceLineRef' is not null)::int with_source_id
    from document_lines where org_id=${ORG} and project_id is not null`);
console.log("\nJOB-COST LINES");
console.log(`  ${c.lines} project lines: billable ${c.billable}, ticketed ${c.ticketed}, markup ${c.with_markup}, source id ${c.with_source_id}`);

// Cost and revenue are read from the account's P&L role, not a guessed type
// name: a chart may call the cost of work 'cogs' or 'expense' and its sales
// 'income' or 'revenue', and assuming one silently reports zero for the other.
const gl = await one(sql`
  select count(distinct jl.project_id)::int projects_with_gl,
         coalesce(sum(jl.amount) filter (where a.type in ('cogs','expense','expense_other')),0)::text cost,
         coalesce(sum(-jl.amount) filter (where a.type in ('income','revenue','income_other')),0)::text revenue,
         count(*) filter (where a.type in ('cogs','expense','expense_other'))::int cost_lines,
         count(*) filter (where a.type in ('income','revenue','income_other'))::int revenue_lines
    from journal_lines jl join accounts a on a.id=jl.account_id
   where jl.org_id=${ORG} and jl.project_id is not null`);
const untagged = await one(sql`
  select coalesce(sum(jl.amount) filter (where a.type in ('cogs','expense','expense_other')),0)::text cost,
         coalesce(sum(-jl.amount) filter (where a.type in ('income','revenue','income_other')),0)::text revenue
    from journal_lines jl join accounts a on a.id=jl.account_id
   where jl.org_id=${ORG} and jl.project_id is null`);
const money = (v:unknown) => Number(v).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
const pct = (a:unknown,b:unknown) => {const t=Number(a)+Number(b); return t? (100*Number(a)/t).toFixed(1)+'%':'n/a'};
console.log("\nPOSTED JOB FINANCIALS (general ledger)");
console.log(`  projects with GL activity ${gl.projects_with_gl}`);
console.log(`  job revenue ${money(gl.revenue)}  (${pct(gl.revenue, untagged.revenue)} of all revenue is job-tagged)`);
console.log(`  job cost    ${money(gl.cost)}  (${pct(gl.cost, untagged.cost)} of all cost is job-tagged)`);
console.log(`  job gross   ${money(Number(gl.revenue)-Number(gl.cost))}  (${(100*(Number(gl.revenue)-Number(gl.cost))/Number(gl.revenue)).toFixed(1)}%)`);

const inv = existsSync("/tmp/ft-batch-results.json") ? JSON.parse(readFileSync("/tmp/ft-batch-results.json","utf8")) as any[] : [];
const scored = inv.filter((r)=>r.replay!==null);
if (scored.length) {
  const exact = scored.filter((r)=>r.status==="exact").length;
  const golden = scored.reduce((t,r)=>t+r.net,0), replay = scored.reduce((t,r)=>t+r.replay,0);
  console.log("\nNATIVE INVOICE REBUILD (replayed from tickets through the real engine)");
  console.log(`  ${exact}/${scored.length} penny-exact (${(100*exact/scored.length).toFixed(1)}%)`);
  console.log(`  golden ${golden.toFixed(2)} vs replay ${replay.toFixed(2)} = ${(replay-golden).toFixed(2)} (${(100*(replay-golden)/golden).toFixed(2)}%)`);
}
process.exit(0);
