/** Attach cost/order lines to the field ticket they were consumed on, from a
 *  legacy export of per-line ticket tags. Matches on (source document number,
 *  line amount) and sets document_lines.field_ticket_id. Set-based, resumable. */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG = process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();
const APPLY = process.argv.includes("--apply");
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let last:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){last=e;const c:string[]=[];for(let x:any=e;x;x=x.cause)c.push(String(x?.message??""));if(!/timeout|terminated|ECONN|ETIMEDOUT|Connection/i.test(c.join(" ")))throw e;await new Promise(r=>setTimeout(r,1000*(i+1)))}}throw last}
(async()=>{
  const env=(await retry(()=>db.execute(sql`select env_kind from orgs where id=${ORG}`))) as any;
  if(env.rows[0]?.env_kind!=="sandbox") throw new Error("refusing: not a sandbox");
  const rows=JSON.parse(readFileSync("/tmp/ns-tslines.json","utf8")) as {tid:string;ts:string;amt:string}[];
  const tix=new Map<string,string>(((( await retry(()=>db.execute(sql`
    select document_number n, id from documents where org_id=${ORG} and kind='field_ticket'`))) as any).rows as any[]).map(x=>[String(x.n),String(x.id)]));
  console.log(`export ${rows.length} tagged lines | tickets in OpenBooks ${tix.size}`);
  const batch:{doc:string;amt:string;tix:string}[]=[];
  let updated=0, noTicket=0;
  const flush=async()=>{ if(!batch.length) return;
    const r=(await retry(()=>db.execute(sql`
      update document_lines dl set field_ticket_id = v.tix::uuid
        from (select unnest(${`{${batch.map(b=>b.doc).join(",")}}`}::text[]) docnum,
                     unnest(${`{${batch.map(b=>b.amt).join(",")}}`}::numeric[]) amt,
                     unnest(${`{${batch.map(b=>b.tix).join(",")}}`}::uuid[]) tix) v
        join documents d on d.org_id=${ORG} and d.document_number=v.docnum
       where dl.org_id=${ORG} and dl.document_id=d.id and dl.field_ticket_id is null
         and abs(abs(dl.amount)-abs(v.amt))<0.005`))) as any;
    updated+=r.rowCount??0; batch.length=0; };
  for(const r of rows){
    const t=tix.get(String(r.ts)); if(!t){noTicket++;continue}
    batch.push({doc:String(r.tid),amt:String(Number(r.amt??0)),tix:t});
    if(APPLY && batch.length>=400) await flush();
  }
  if(APPLY) await flush();
  console.log(`${APPLY?"linked":"PLAN would link"}: ${updated} cost lines | ticket not found ${noTicket}`);
  if(APPLY){const v=(await retry(()=>db.execute(sql`select count(*)::int n from document_lines where org_id=${ORG} and field_ticket_id is not null`))) as any;console.log("verify cost lines with a ticket:",v.rows[0].n);}
  process.exit(0);
})().catch(e=>{const c:string[]=[];for(let x:any=e;x;x=x.cause)if(x?.message)c.push(String(x.message).replace(/\s+/g," ").slice(0,180));console.error("FATAL:",c.pop());process.exit(1)});
