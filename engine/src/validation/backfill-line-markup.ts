/** Bring each cost line's OWN markup across from the source, into
 *  document_lines.cost_multiplier, so billing marks up per line instead of
 *  falling back to one flat project rate. */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
const ORG=process.env.SANDBOX_ORG ?? (() => { throw new Error("SANDBOX_ORG is required"); })();
const APPLY=process.argv.includes("--apply");
async function retry<T>(fn:()=>Promise<T>,n=8):Promise<T>{let last:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){last=e;const c:string[]=[];for(let x:any=e;x;x=x.cause)c.push(String(x?.message??""));if(!/timeout|terminated|ECONN|ETIMEDOUT|Connection/i.test(c.join(" ")))throw e;await new Promise(r=>setTimeout(r,1000*(i+1)))}}throw last}
/** Sources write markup either as a percent (15) or a fraction (0.15). */
const mult=(raw:string):string=>{const v=Number(raw??0);if(!isFinite(v)||v<=0)return "1";return (1+(v>0&&v<=1?v:v/100)).toFixed(4)};
(async()=>{
  const env=(await retry(()=>db.execute(sql`select env_kind from orgs where id=${ORG}`))) as any;
  if(env.rows[0]?.env_kind!=="sandbox") throw new Error("refusing: not a sandbox");
  const rows=JSON.parse(readFileSync("/tmp/ns-markup.json","utf8")) as {tid:string;amt:string;mk:string}[];
  console.log(`source lines with markup: ${rows.length}`);
  let updated=0; const batch:{doc:string;amt:string;m:string}[]=[];
  const flush=async()=>{if(!batch.length)return;
    const r=(await retry(()=>db.execute(sql`
      update document_lines dl set cost_multiplier = v.m::numeric
        from (select unnest(${`{${batch.map(b=>b.doc).join(",")}}`}::text[]) docnum,
                     unnest(${`{${batch.map(b=>b.amt).join(",")}}`}::numeric[]) amt,
                     unnest(${`{${batch.map(b=>b.m).join(",")}}`}::numeric[]) m) v
        join documents d on d.org_id=${ORG} and d.document_number=v.docnum
       where dl.org_id=${ORG} and dl.document_id=d.id
         and abs(abs(dl.amount)-abs(v.amt))<0.005
         and (dl.cost_multiplier is null or dl.cost_multiplier = 0)`))) as any;
    updated+=r.rowCount??0; batch.length=0};
  for(const r of rows){ batch.push({doc:String(r.tid),amt:String(Number(r.amt??0)),m:mult(String(r.mk))});
    if(APPLY&&batch.length>=400) await flush(); }
  if(APPLY) await flush();
  console.log(`${APPLY?"set":"PLAN"}: ${updated} lines given their own markup`);
  process.exit(0);
})().catch(e=>{const c:string[]=[];for(let x:any=e;x;x=x.cause)if(x?.message)c.push(String(x.message).replace(/\s+/g," ").slice(0,180));console.error("FATAL:",c.pop());process.exit(1)});
