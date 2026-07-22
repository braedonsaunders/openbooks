import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { Badge, DetailHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../../../components/page-layout'
import { entryDetail } from '../../../../lib/data'
import { requirePermission } from '../../../../lib/authz'

export const dynamic = 'force-dynamic'

// journal_entries.origin enum → message key under journal.origins.*
// (unknown/custom origins render verbatim).
const ORIGIN_KEYS: Record<string, string> = {
  manual: 'manual',
  closing: 'closing',
  allocation: 'allocation',
  revaluation: 'revaluation',
  labor_burden: 'laborBurden',
  depreciation: 'depreciation',
  revenue_recognition: 'revenueRecognition',
  fx_settlement: 'fxSettlement',
  translation: 'translation',
}

// journal_entries.status enum → common.status.* key (unknown values render verbatim).
const STATUS_KEYS: Record<string, string> = {
  posted: 'posted',
  reversed: 'reversed',
  draft: 'draft',
  voided: 'voided',
}

export default async function Entry({ params }: { params: Promise<{ id: string }> }) {
  const { money } = await getMoneyFormatter()
  const authz = await requirePermission('gl.read')
  const t = await getTranslations('journal')
  const tc = await getTranslations('common')
  const { id } = await params
  const { entry, lines } = await entryDetail(authz.user.orgId, id)
  if (!entry) return <PageContainer>{t('detail.notFound')}</PageContainer>

  const debits = lines.filter((l: any) => Number(l.amount) > 0).reduce((a: number, l: any) => a + Number(l.amount), 0)

  return (
    <PageContainer>
      <DetailHeader
        title={entry.entry_number}
        subtitle={[
          entry.posting_date,
          entry.memo ?? '',
          t('detail.origin', {
            origin: ORIGIN_KEYS[entry.origin] ? t(`origins.${ORIGIN_KEYS[entry.origin]}`) : entry.origin,
          }),
          entry.reverses_number ? t('detail.reverses', { number: entry.reverses_number }) : null,
        ]
          .filter((s) => s != null)
          .join(' · ')}
        badge={
          <Badge variant={entry.status === 'posted' ? 'success' : 'destructive'}>
            {STATUS_KEYS[entry.status] ? tc(`status.${STATUS_KEYS[entry.status]}`) : entry.status}
          </Badge>
        }
        back={{ href: '/journal', label: t('list.title') }}
      />
      <div className="mt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>{tc('labels.account')}</TableHead>
              <TableHead>{tc('labels.party')}</TableHead>
              <TableHead>{tc('labels.department')}</TableHead>
              <TableHead className="text-right">{t('detail.columns.debit')}</TableHead>
              <TableHead className="text-right">{t('detail.columns.credit')}</TableHead>
              <TableHead>{t('detail.columns.openItem')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l: any) => {
              const amt = Number(l.amount)
              return (
                <TableRow key={l.line_number}>
                  <TableCell className="text-slate-400">{l.line_number}</TableCell>
                  <TableCell>
                    <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">
                      {l.account_number}
                    </span>
                    {l.account_name}
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{l.party}</TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{l.department}</TableCell>
                  <TableCell className="text-right tabular-nums">{amt > 0 ? money(amt) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{amt < 0 ? money(-amt) : ''}</TableCell>
                  <TableCell>{l.is_open_item ? <Badge variant="outline">{t('detail.openItemBadge')}</Badge> : null}</TableCell>
                </TableRow>
              )
            })}
            <TableRow>
              <TableCell colSpan={4} className="font-semibold">
                {t('detail.totals')}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(debits)}</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money(debits)}</TableCell>
              <TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </PageContainer>
  )
}
