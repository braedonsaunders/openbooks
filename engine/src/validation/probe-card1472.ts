import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2500*(i+1)))}}throw l}
const r:any=await retry(()=>db.execute(sql`
  select b.code, b.name, v.status, v.effective_from::text ef, v.effective_to::text et,
         dp.name scope, a.code adj, a.value::text val, a.presentation
    from projects p
    join item_rate_book_assignments asg on asg.project_id=p.id
    join item_rate_books b on b.id=asg.rate_book_id
    join item_rate_versions v on v.rate_book_id=b.id
    left join labor_rate_version_scopes vs on vs.version_id=v.id
    left join departments dp on dp.id=vs.scope_value_id
    left join labor_rate_adjustments a on a.version_id=v.id and a.code in ('source-surcharge','fuel')
   where p.org_id=${ORG} and p.custom->>'nsId'='73839'`));
console.log("cards assigned to job 73839:"); console.table(r.rows);
process.exit(0);
