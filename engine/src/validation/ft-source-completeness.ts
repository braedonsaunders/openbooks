/**
 * Separate ENGINE error from MISSING SOURCE DATA in a field-ticket replay.
 *
 * A replayed invoice can only match its original if OpenBooks actually holds
 * every charge the original billed. This counts, per replay outcome, how often
 * the golden invoice's line count equals the crew hours OpenBooks has linked to
 * the same tickets — so a shortfall traceable to un-imported charges is not
 * mistaken for a billing defect. Invoices that are COMPLETE but still off are
 * the real defect candidates and are printed individually.
 *
 * Usage: npx tsx --conditions=react-server src/validation/ft-source-completeness.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const load=(f:string)=>{const d=JSON.parse(readFileSync(f,"utf8"));return Array.isArray(d)?d:Object.values(d)[0] as any[];};
const ts=load("/tmp/ns-tslines.json");
const byTid=new Map<string,number>(); for(const r of ts) byTid.set(String(r.tid),(byTid.get(String(r.tid))??0)+1);
const res=JSON.parse(readFileSync("/tmp/ft-batch-results.json","utf8")).filter((r:any)=>r.replay!==null);
const invs=JSON.parse(readFileSync("/tmp/ft-invoices.json","utf8"));
const tally:Record<string,{n:number;match:number}>={};
for (const r of res) {
  const inv:any=invs.find((i:any)=>i.tranid===r.tranid); if(!inv) continue;
  const t:any=await db.execute(sql`
    select id from documents where org_id=${ORG} and kind='field_ticket'
     and document_number = any(${`{${inv.tickets.join(",")}}`}::text[])`);
  const c:any=await db.execute(sql`
    select count(*)::int n from time_entries where org_id=${ORG}
     and field_ticket_id = any(${`{${t.rows.map((x:any)=>x.id).join(",")}}`}::uuid[]) and is_billable`);
  const golden=byTid.get(String(inv.id))??0, ours=c.rows[0].n;
  const k=r.status; tally[k]??={n:0,match:0}; tally[k].n++; if(golden===ours) tally[k].match++;
  if (golden===ours && k!=="exact") console.log(`  COMPLETE-BUT-OFF ${r.tranid} job ${r.job} golden ${r.net} replay ${r.replay} delta ${r.delta.toFixed(2)} lines ${golden}`);
}
console.log("\nDo the golden invoice's labor lines equal the crew hours OpenBooks holds?");
for (const [k,v] of Object.entries(tally)) console.log(`  ${k.padEnd(6)} ${v.n} invoices — line counts agree on ${v.match} (${(100*v.match/v.n).toFixed(0)}%)`);
process.exit(0);
