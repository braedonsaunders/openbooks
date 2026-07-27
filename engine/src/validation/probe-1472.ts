import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2500*(i+1)))}}throw l}
for (const t of ["INV1472","INV0663"]) {
  const d:any=await retry(()=>db.execute(sql`
    select id, subtotal::text st from documents where org_id=${ORG} and memo=${"Replay of "+t} order by created_at desc limit 1`));
  const r:any=await retry(()=>db.execute(sql`
    select coalesce(sum(amount) filter (where time_entry_id is not null),0)::text labor,
           coalesce(sum(amount) filter (where time_entry_id is null and description not ilike '%surcharge%'),0)::text nonlabor,
           coalesce(sum(amount) filter (where description ilike '%surcharge%'),0)::text charge
      from document_lines where document_id=${d.rows[0].id}`));
  const x=r.rows[0];
  const lab=Number(x.labor), non=Number(x.nonlabor), ch=Number(x.charge);
  console.log(`${t}: labor ${lab.toFixed(2)}  other ${non.toFixed(2)}  charge ${ch.toFixed(2)}  subtotal ${d.rows[0].st}`);
  console.log(`   3.75% of labor = ${(lab*0.0375).toFixed(2)}   3.75% of (labor+other) = ${((lab+non)*0.0375).toFixed(2)}`);
}
process.exit(0);
