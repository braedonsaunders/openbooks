import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { balanceSheet } from '../../../../lib/reports'
import { money } from '../../../../lib/format'
import { StatementTable } from '../StatementTable'
import { StatementExport } from '../StatementExport'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const ASSET_TYPES = ['asset_bank', 'asset_receivable', 'asset_current_other', 'asset_fixed', 'asset_other']
const LIAB_TYPES = ['liability_payable', 'liability_card', 'liability_current_other', 'liability_long_term']

export default async function BalanceSheet({ searchParams }: { searchParams: Promise<{ asof?: string }> }) {
  const t = await getTranslations('reports')
  const { asof } = await searchParams
  const date = asof ?? new Date().toISOString().slice(0, 10)
  const bs = await balanceSheet(date)
  const balanced = Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity)) < 0.01

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('balanceSheet.title')}
            description={t('balanceSheet.asOf', { date })}
            back={{ href: '/reports', label: t('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="balance-sheet" params={{ asOf: date }} /></>}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: t('balanceSheet.assets'), value: money(bs.totalAssets) },
              { label: t('balanceSheet.liabilities'), value: money(bs.totalLiabilities) },
              { label: t('balanceSheet.equity'), value: money(bs.totalEquity) },
            ].map((s) => (
              <Card key={s.label}>
                <CardContent className="p-4">
                  <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                    {s.label}
                  </span>
                  <span className="block text-xl font-semibold tabular-nums">{s.value}</span>
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  {t('balanceSheet.equation')}
                </span>
                <span className={cn('mt-1 inline-block')}>
                  <Badge variant={balanced ? 'success' : 'destructive'}>
                    {balanced
                      ? t('balanceSheet.balanced')
                      : t('balanceSheet.offBy', { amount: money(bs.totalAssets - bs.totalLiabilities - bs.totalEquity) })}
                  </Badge>
                </span>
              </CardContent>
            </Card>
          </div>
        </>
      }
    >
      <StatementTable
        sections={[
          { title: t('balanceSheet.assets'), types: ASSET_TYPES, rows: bs.assets, total: bs.totalAssets },
          { title: t('balanceSheet.liabilities'), types: LIAB_TYPES, rows: bs.liabilities, total: bs.totalLiabilities },
          { title: t('balanceSheet.equity'), types: ['equity'], rows: bs.equity, total: bs.totalEquity },
        ]}
        period={{ to: date }}
      />
    </ListPageLayout>
  )
}
