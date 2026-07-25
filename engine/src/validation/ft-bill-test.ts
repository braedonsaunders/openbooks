import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { generateInvoiceFromBillingRequest } from "../../../web/lib/billing.ts";
const O="6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const NUMS=(process.argv.find(a=>a.startsWith("--tickets="))?.split("=")[1] ?? "").split(",").filter(Boolean);
const GOLD=Number(process.argv.find(a=>a.startsWith("--golden="))?.split("=")[1] ?? "0");
(async()=>{
  const t:any=await db.execute(sql`select id, document_number, project_id, document_date::text d from documents where org_id=${O} and kind='field_ticket' and document_number = any(${`{${NUMS.join(",")}}`}::text[])`);
  console.log("tickets found:", t.rows.length, t.rows.map((x:any)=>`${x.document_number}@${x.d}`).join(" "));
  if(!t.rows.length) process.exit(1);
  const pid=t.rows[0].project_id;
  const ids=t.rows.map((x:any)=>x.id);
  const te:any=await db.execute(sql`select count(*)::int n, coalesce(sum(hours),0)::text h, coalesce(sum(hours*coalesce(bill_rate,0)),0)::text v from time_entries where org_id=${O} and field_ticket_id = any(${`{${ids.join(",")}}`}::uuid[])`);
  console.log("labor on these tickets:", JSON.stringify(te.rows[0]));
  const actor=((await db.execute(sql`select id from users where org_id=${O} order by created_at limit 1`)) as any).rows[0].id;
  const rid=randomUUID();
  await db.execute(sql`insert into billing_requests (id,org_id,project_id,request_number,invoice_type,basis,status,invoice_description,custom,created_by)
    values (${rid},${O},${pid},${"FT-"+randomUUID().slice(0,6)},'progress','field_ticket','open','Field-ticket basis test',${JSON.stringify({fieldTicketIds:ids})}::jsonb,${actor})`);
  const out=await generateInvoiceFromBillingRequest(O,actor,rid);
  const d:any=await db.execute(sql`select subtotal::text s, (select count(*) from document_lines where document_id=${out.id})::int n from documents where id=${out.id}`);
  const sub=Number(d.rows[0].s);
  console.log(`replay invoice: $${sub.toFixed(2)} across ${d.rows[0].n} lines`);
  if(GOLD) console.log(`golden $${GOLD.toFixed(2)}  delta $${(sub-GOLD).toFixed(2)}  (${(100*(sub-GOLD)/GOLD).toFixed(2)}%)`);
  process.exit(0);
})().catch(e=>{const c:string[]=[];for(let x:any=e;x;x=x.cause)if(x?.message)c.push(String(x.message).replace(/\s+/g," ").slice(0,160));console.error("FATAL:",c.pop());process.exit(1);});
