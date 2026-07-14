import { worklist } from '@openbooks/engine/src/approvals.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { CheckCircle2 } from 'lucide-react'
import { ListPageLayout } from '../../../components/page-layout'
import { currentUser } from '../../../lib/auth'
import { money } from '../../../lib/format'
import { DecideButtons } from './DecideButtons'

export const dynamic = 'force-dynamic'

export default async function Approvals() {
  const user = await currentUser()
  if (!user) return null
  const items = await worklist(user.orgId, user.role)

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Approvals"
          description={`Pending items assigned to your role (${user.role}).`}
        />
      }
    >
      {items.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 />}
          title="Nothing waiting on you"
          description="Approval requests routed to your role will appear here."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Party</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i: any) => (
              <TableRow key={i.step_id}>
                <TableCell className="font-mono text-[13px] font-semibold">{i.document_number}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{String(i.kind).replace('_', ' ')}</Badge>
                </TableCell>
                <TableCell>{i.party}</TableCell>
                <TableCell>{i.document_date}</TableCell>
                <TableCell className="text-right tabular-nums">{money(i.amount)}</TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">step {i.step_number}</TableCell>
                <TableCell>
                  <DecideButtons requestId={i.request_id} stepNumber={i.step_number} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </ListPageLayout>
  )
}
