import { db } from "../db.ts";
import { sql } from "drizzle-orm";
const O="6d5799ad-a37c-4aea-9cd4-748e4dc59614";
(async () => {
  const r:any=await db.execute(sql`
    select d.kind, count(*)::int lines,
           count(*) filter (where dl.is_billable)::int billable,
           coalesce(sum(dl.amount),0)::text value
      from document_lines dl join documents d on d.id=dl.document_id
     where dl.org_id=${O} and dl.project_id is not null
       and d.kind in ('vendor_bill','expense_report','card_charge','check','project_charge','sales_order')
     group by d.kind order by 2 desc`);
  console.log("PROJECT-TAGGED COST LINES (whole sandbox):");
  console.log("  kind              lines   billable        value");
  for(const x of r.rows) console.log(`  ${String(x.kind).padEnd(16)} ${String(x.lines).padStart(6)} ${String(x.billable).padStart(10)} ${Number(x.value).toFixed(2).padStart(14)}`);
  const te:any=await db.execute(sql`select count(*)::int n, count(*) filter (where is_billable)::int billable, count(*) filter (where status='approved')::int approved from time_entries where org_id=${O} and project_id is not null`);
  console.log("PROJECT TIME ENTRIES:", JSON.stringify(te.rows[0]));
  process.exit(0);
})();
