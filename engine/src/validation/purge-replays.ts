/**
 * Remove the draft invoices left behind by earlier replay runs.
 *
 * Each run created a fresh draft per invoice, so repeated runs accumulate. They
 * never posted, so no ledger is affected — but they bury the tenant's real work.
 * Usage: npx tsx --conditions=react-server src/validation/purge-replays.ts [--apply]
 */
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { resolveTargetOrg } from "./target-org.ts";
const ORG = process.env.SANDBOX_ORG ?? "6d5799ad-a37c-4aea-9cd4-748e4dc59614";
const APPLY = process.argv.includes("--apply");
async function retry<T>(fn:()=>Promise<T>,n=10):Promise<T>{let l:unknown;for(let i=0;i<n;i++){try{return await fn()}catch(e){l=e;await new Promise(r=>setTimeout(r,2500*(i+1)))}}throw l}

await resolveTargetOrg(ORG);

const found:any = await retry(()=>db.execute(sql`
  select count(*)::int n, count(*) filter (where status <> 'draft')::int posted
    from documents where org_id=${ORG} and kind='customer_invoice' and memo like 'Replay of %'`));
console.log(`${found.rows[0].n} replay invoices (${found.rows[0].posted} of them not draft)`);
if (found.rows[0].posted > 0) throw new Error("refusing: a replay invoice has been posted — inspect before purging");
if (!APPLY) { console.log("(plan only — pass --apply)"); process.exit(0); }

// Release provenance first so the work becomes billable again, then delete.
await retry(()=>db.execute(sql`
  update time_entries set invoiced_by_line_id = null, billing_status = 'unbilled' where org_id=${ORG} and invoiced_by_line_id in (
    select dl.id from document_lines dl join documents d on d.id=dl.document_id
     where d.org_id=${ORG} and d.kind='customer_invoice' and d.memo like 'Replay of %')`));
await retry(()=>db.execute(sql`
  update document_lines set billed_by_line_id = null where org_id=${ORG} and billed_by_line_id in (
    select dl.id from document_lines dl join documents d on d.id=dl.document_id
     where d.org_id=${ORG} and d.kind='customer_invoice' and d.memo like 'Replay of %')`));
const lines:any = await retry(()=>db.execute(sql`
  delete from document_lines where document_id in (
    select id from documents where org_id=${ORG} and kind='customer_invoice' and memo like 'Replay of %')`));
const docs:any = await retry(()=>db.execute(sql`
  delete from documents where org_id=${ORG} and kind='customer_invoice' and memo like 'Replay of %'`));
console.log(`purged ${docs.rowCount} invoices, ${lines.rowCount} lines`);
process.exit(0);
