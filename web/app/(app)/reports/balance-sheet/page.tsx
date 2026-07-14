import { Badge, Card, CardContent, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { balanceSheet } from '../../../../lib/reports'
import { money } from '../../../../lib/format'
import { StatementTable } from '../StatementTable'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const ASSET_TYPES = ['asset_bank', 'asset_receivable', 'asset_current_other', 'asset_fixed', 'asset_other']
const LIAB_TYPES = ['liability_payable', 'liability_card', 'liability_current_other', 'liability_long_term']

export default async function BalanceSheet({ searchParams }: { searchParams: Promise<{ asof?: string }> }) {
  const { asof } = await searchParams
  const date = asof ?? new Date().toISOString().slice(0, 10)
  const bs = await balanceSheet(date)
  const balanced = Math.abs(bs.totalAssets - (bs.totalLiabilities + bs.totalEquity)) < 0.01

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Balance Sheet"
            description={`as of ${date}`}
            back={{ href: '/reports', label: 'Reports' }}
            actions={<SaveViewButton />}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: 'Assets', value: money(bs.totalAssets) },
              { label: 'Liabilities', value: money(bs.totalLiabilities) },
              { label: 'Equity', value: money(bs.totalEquity) },
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
                  A = L + E
                </span>
                <span className={cn('mt-1 inline-block')}>
                  <Badge variant={balanced ? 'success' : 'destructive'}>
                    {balanced ? 'balanced' : `off by ${money(bs.totalAssets - bs.totalLiabilities - bs.totalEquity)}`}
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
          { title: 'Assets', types: ASSET_TYPES, rows: bs.assets, total: bs.totalAssets },
          { title: 'Liabilities', types: LIAB_TYPES, rows: bs.liabilities, total: bs.totalLiabilities },
          { title: 'Equity', types: ['equity'], rows: bs.equity, total: bs.totalEquity },
        ]}
      />
    </ListPageLayout>
  )
}
