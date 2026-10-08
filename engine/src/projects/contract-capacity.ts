import { sql } from "drizzle-orm"
import type { SqlExecutor } from "../platform/db.ts"
import { normalizeMoney } from "../money/money.ts"
import { pgTextArrayLiteral } from "../platform/pg-array.ts"

/** Reserved capacity includes non-voided invoices less credits and unconverted open prebilling worksheets. */
export async function projectContractCapacityUsed(
  executor: SqlExecutor,
  orgId: string,
  projectId: string,
  invoicedToDate: { docKinds: string[]; creditKinds: string[] },
  options: { excludePrebillId?: string } = {},
): Promise<string> {
  const invoiceKinds = invoicedToDate.docKinds.length ? invoicedToDate.docKinds : ['customer_invoice']
  const creditKinds = invoicedToDate.creditKinds.length ? invoicedToDate.creditKinds : ['customer_credit']
  const allKinds = [...new Set([...invoiceKinds, ...creditKinds])]
  const excludePrebillId = options.excludePrebillId ?? null
  const used = (await executor.execute<{ used: string }>(sql`
    select coalesce((
             select sum(case when document.kind = any(${pgTextArrayLiteral(creditKinds)}::text[])
                             then -line.amount else line.amount end)
               from document_lines line
               join documents document on document.org_id = line.org_id and document.id = line.document_id
              where line.org_id = ${orgId}
                and coalesce(line.project_id, document.project_id) = ${projectId}
                and document.status <> 'voided'
                and document.kind = any(${pgTextArrayLiteral(allKinds)}::text[])
           ), 0)
           + coalesce((
             select sum(worksheet.proposed_bill_amount)
               from prebills worksheet
              where worksheet.org_id = ${orgId} and worksheet.project_id = ${projectId}
                and worksheet.status in ('draft', 'review', 'approved')
                and (${excludePrebillId}::uuid is null or worksheet.id <> ${excludePrebillId})
           ), 0) as used
  `))
  return normalizeMoney(used.rows[0]?.used ?? '0')
}
