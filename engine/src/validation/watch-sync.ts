import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = (process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })());
async function retry<T>(fn:()=>Promise<T>,n=6):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2000*(i+1)))}}throw l}
const r:any = await retry(()=>db.execute(sql`
  select id, kind, status, started_at, finished_at, progress, error_message
    from sync_runs where org_id=${ORG} order by started_at desc limit 3`));
for (const x of r.rows) console.log(`${String(x.status).padEnd(8)} ${x.kind} started ${x.started_at} progress=${JSON.stringify(x.progress)} ${x.error_message ?? ""}`.slice(0,220));
process.exit(0);
