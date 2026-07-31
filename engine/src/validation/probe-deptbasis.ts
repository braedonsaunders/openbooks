import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveRateAdjustments } from "../../../web/lib/rate-adjustments.ts";
const ORG = (process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })());
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2500*(i+1)))}}throw l}
const invs=JSON.parse(readFileSync("/tmp/ft-invoices.json","utf8"));
for (const t of ["INV1472"]) {
  const inv:any=invs.find((i:any)=>i.tranid===t);
  const d:any=await retry(()=>db.execute(sql`
    select id from documents where org_id=${ORG} and memo=${"Replay of "+t} order by created_at desc limit 1`));
  const r:any=await retry(()=>db.execute(sql`
    select dp.name dept, dp.id did, count(*)::int lines, sum(dl.amount)::text amt
      from document_lines dl
      join time_entries te on te.id=dl.time_entry_id
      left join departments dp on dp.id=te.department_id
     where dl.document_id=${d.rows[0].id} group by 1,2 order by 4 desc`));
  console.log(`${t} labor by department:`);
  const p:any=await retry(()=>db.execute(sql`select id from projects where org_id=${ORG} and custom->>'nsId'=${String(inv.job)} limit 1`));
  const work:any=await retry(()=>db.execute(sql`
    select max(worked_on)::text d from time_entries te join document_lines dl on dl.time_entry_id=te.id
     where dl.document_id=${d.rows[0].id}`));
  for (const row of r.rows) {
    const adj=await resolveRateAdjustments({orgId:ORG,projectId:p.rows[0].id,onDate:work.rows[0].d,departmentId:row.did});
    const sep=adj.filter(a=>a.presentation==='separate'&&Number(a.value)>0).map(a=>`${a.code}=${a.value}`).join(",");
    console.log(`   ${String(row.dept).padEnd(14)} ${String(row.lines).padStart(4)} lines  ${Number(row.amt).toFixed(2).padStart(12)}   surcharge: ${sep||"NONE"}`);
  }
}
process.exit(0);
