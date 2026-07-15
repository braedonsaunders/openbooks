import { worklist } from '@openbooks/engine/src/approvals.ts'
import { getTranslations } from 'next-intl/server'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { CheckCircle2 } from 'lucide-react'
import { ListPageLayout } from '../../../components/page-layout'
import { currentUser } from '../../../lib/auth'
import { money } from '../../../lib/format'
import { DecideButtons } from './DecideButtons'

export const dynamic = 'force-dynamic'

// Document kinds with catalog labels — unknown kinds fall back to the raw code.
const KIND_KEYS = [
  'vendor_bill',
  'customer_invoice',
  'expense_report',
  'journal',
  'purchase_order',
  'sales_order',
  'quote',
]

export default async function Approvals() {
  const t = await getTranslations('approvals')
  const tc = await getTranslations('common')
  const user = await currentUser()
  if (!user) return null
  const items = await worklist(user.orgId, user.role)

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t('title')}
          description={t('description', { role: user.role })}
        />
      }
    >
      {items.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 />}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('table.document')}</TableHead>
              <TableHead>{t('table.kind')}</TableHead>
              <TableHead>{tc('labels.party')}</TableHead>
              <TableHead>{tc('labels.date')}</TableHead>
              <TableHead className="text-right">{tc('labels.amount')}</TableHead>
              <TableHead>{t('table.step')}</TableHead>
              <TableHead>{t('table.decision')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((i: any) => (
              <TableRow key={i.step_id}>
                <TableCell className="font-mono text-[13px] font-semibold">{i.document_number}</TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {KIND_KEYS.includes(String(i.kind))
                      ? t(`kinds.${i.kind}`)
                      : String(i.kind).replace('_', ' ')}
                  </Badge>
                </TableCell>
                <TableCell>{i.party}</TableCell>
                <TableCell>{i.document_date}</TableCell>
                <TableCell className="text-right tabular-nums">{money(i.amount)}</TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">
                  {t('table.stepNumber', { number: String(i.step_number) })}
                </TableCell>
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
