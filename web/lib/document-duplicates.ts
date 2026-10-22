import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/db'
import { subsidiaryVisibleFilter } from '@/lib/subsidiaries'

/**
 * Possible duplicates of a document about to be saved: non-voided documents
 * of the same kind for the same party, document date and total — plus the
 * same vendor reference for bills — inside the caller's subsidiary scope.
 */
export async function findPossibleDuplicates(input: {
  orgId: string
  kind: 'customer_invoice' | 'vendor_bill'
  partyId: string
  documentDate: string
  total: string
  reference: string
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined
}): Promise<{ id: string; documentNumber: string }[]> {
  return await db.execute<{ id: string; documentNumber: string }>(sql`
    select id, document_number as "documentNumber" from documents
     where org_id = ${input.orgId} and kind = ${input.kind}
       and status <> 'voided'
       and party_id = ${input.partyId}
       and document_date = ${input.documentDate}::date
       and total = ${input.total}
       ${input.kind === 'vendor_bill' ? sql`and nullif(btrim(reference_number), '') = ${input.reference}` : sql``}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, input.allowedSubsidiaryIds ?? null)}
     order by document_date desc, id
     limit 5`, 'objects')
}
