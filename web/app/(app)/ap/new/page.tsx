import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { BillForm } from './BillForm'

export const dynamic = 'force-dynamic'

export default async function NewBill() {
  const vendors = (await db.execute(sql`
    select id, display_name from parties
     where custom->>'nsKind' = 'vendor' and is_active
     order by display_name limit 2000`)) as any
  const accounts = (await db.execute(sql`
    select id, number, name from accounts
     where type in ('expense','expense_other','cogs','asset_fixed','asset_current_other')
       and is_active and not is_summary
     order by number nulls last`)) as any
  const taxCodes = (await db.execute(sql`select id, code, name from tax_codes where is_active order by code`)) as any

  return (
    <PageContainer className="max-w-4xl">
      <PageHeader
        title="New vendor bill"
        description="Saved as a draft, then routed by the vendor-bill approval policy."
        back={{ href: '/ap', label: 'Accounts Payable' }}
      />
      <div className="mt-6">
        <BillForm vendors={vendors.rows} accounts={accounts.rows} taxCodes={taxCodes.rows} />
      </div>
    </PageContainer>
  )
}
