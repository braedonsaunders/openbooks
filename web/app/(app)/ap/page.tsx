import Link from 'next/link'
import { Plus } from 'lucide-react'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { money } from '../../../lib/format'
import { BillActions } from './BillActions'

export const dynamic = 'force-dynamic'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  posted: 'success',
  approved: 'success',
  pending_approval: 'warning',
  draft: 'secondary',
  voided: 'outline',
}

export default async function AP() {
  const bills = (await db.execute(sql`
    select d.id, d.document_number, d.document_date, d.due_date, d.status, d.total,
           d.reference_number, d.memo, p.display_name as vendor, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
     where d.kind = 'vendor_bill'
     order by d.created_at desc limit 100
  `)) as any

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Accounts Payable"
          description="Vendor bills entered in openbooks — draft → approval → posted through the kernel."
          actions={
            <Button asChild>
              <Link href="/ap/new">
                <Plus size={15} /> New bill
              </Link>
            </Button>
          }
        />
      }
    >
      {bills.rows.length === 0 ? (
        <EmptyState
          title="No bills yet"
          description="Enter the first vendor bill to start the AP workflow."
          action={
            <Button asChild>
              <Link href="/ap/new">New bill</Link>
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Bill</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Ref</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {bills.rows.map((b: any) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-[13px] font-semibold">
                  {b.entry_id ? (
                    <Link href={`/journal/${b.entry_id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {b.document_number}
                    </Link>
                  ) : (
                    b.document_number
                  )}
                </TableCell>
                <TableCell>{b.vendor}</TableCell>
                <TableCell>{b.document_date}</TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">{b.reference_number}</TableCell>
                <TableCell className="text-right tabular-nums">{money(b.total)}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[b.status] ?? 'secondary'}>
                    {String(b.status).replace('_', ' ')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <BillActions id={b.id} status={b.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
