import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { cashFlowIndirect, dimensionOptions } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import type { ReportDrillTarget } from '../../../../lib/report-drill'
import { ReportFilterBar } from '../ReportFilterBar'
import { ExportMenu } from '../ExportMenu'
import { SaveViewButton } from '../SaveViewButton'
import { ReportPaper } from '../ReportPaper'
import { Table, TableBody, TableCell, TableRow, reportSubtotalRowClass, reportTotalRowClass } from '../ReportTable'
import { ReportDrillLink } from '../ReportDrillLink'
import type { StatementDimFilter } from '../../../../lib/statement-matrix'

export const dynamic = 'force-dynamic'

const PNL_TYPES = ['income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred']

export default async function CashFlowIndirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('reports.cashFlowIndirect')
  const tr = await getTranslations('reports')
  const sp = await searchParams
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const from = period.from
  const to = period.to
  const dims = q.dims
  const [cf, opts, org] = await Promise.all([cashFlowIndirect(from, to, dims), dimensionOptions(), orgInfo()])
  const m = (v: number) => money(v, { currency: org?.base_currency })
  const openingTo = new Date(`${from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  const reconciled = Math.abs(cf.reconciliationGap) < 0.01
  const hasMovements =
    Math.abs(cf.netIncome) >= 0.005 ||
    cf.adjustments.length > 0 ||
    cf.workingCapital.length > 0 ||
    cf.investing.length > 0 ||
    cf.financing.length > 0

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('title')}
            back={{ href: '/reports', label: tr('hub.title') }}
          />
          <ReportFilterBar
            controls={{ period: true, dimensions: true }}
            dimensions={opts}
            actions={<><SaveViewButton /><ExportMenu kind="cash-flow-indirect" params={sp} /></>}
          />
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span>{t('reconciliation')}</span>
            <Badge variant={reconciled ? 'success' : 'destructive'}>
              {reconciled ? t('reconciled') : t('offBy', { amount: m(cf.reconciliationGap) })}
            </Badge>
          </div>
        </>
      }
    >
      <ReportPaper company={org?.name ?? ''} title={t('title')} periodPhrase={t('dateRange', { from, to })}>
        <Table>
          <TableBody>
          {!hasMovements ? (
            <TableRow>
              <TableCell colSpan={2} className="text-center text-slate-400 italic">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            <>
              <SectionHeader title={t('sections.operating')} />
              <AmountRow
                label={t('netIncome')}
                amount={cf.netIncome}
                m={m}
                drill={{ kind: 'ledger', label: t('netIncome'), accountTypes: PNL_TYPES, from, to, mode: 'flow', dims }}
              />
              {cf.adjustments.length > 0 ? (
                <>
                  <SubHeader title={t('adjustmentsHeader')} />
                  {cf.adjustments.map((a, i) => {
                    const label = a.label ?? t(`adjustments.${a.key}`)
                    return (
                      <AmountRow
                        key={a.accountId ?? `${a.key}-${i}`}
                        label={label}
                        amount={a.amount}
                        m={m}
                        drill={{ kind: 'ledger', label, accountTypes: PNL_TYPES, from, to, mode: 'flow', dims }}
                      />
                    )
                  })}
                </>
              ) : null}
              {cf.workingCapital.length > 0 ? (
                <>
                  <SubHeader title={t('wcHeader')} />
                  {cf.workingCapital.map((l) => (
                    <AmountRow
                      key={l.accountId}
                      label={`${l.number ? `${l.number} · ` : ''}${l.name}`}
                      amount={l.amount}
                      m={m}
                      drill={{ kind: 'ledger', label: l.name, accountIds: [l.accountId], from, to, mode: 'flow', dims }}
                    />
                  ))}
                </>
              ) : null}
              <SubtotalRow
                label={t('subtotals.operating')}
                amount={cf.operating}
                m={m}
                drill={{ kind: 'ledger', label: t('subtotals.operating'), accountTypes: [...PNL_TYPES, ...cf.workingCapital.map((l) => l.type)], from, to, mode: 'flow', dims }}
              />

              <SectionHeader title={t('sections.investing')} />
              {cf.investing.length === 0 ? (
                <EmptySection />
              ) : (
                cf.investing.map((l) => (
                  <AmountRow
                    key={l.accountId}
                    label={`${l.number ? `${l.number} · ` : ''}${l.name}`}
                    amount={l.amount}
                    m={m}
                    drill={{ kind: 'ledger', label: l.name, accountIds: [l.accountId], from, to, mode: 'flow', dims, cashOnly: true }}
                  />
                ))
              )}
              <SubtotalRow
                label={t('subtotals.investing')}
                amount={cf.investingTotal}
                m={m}
                drill={{ kind: 'ledger', label: t('subtotals.investing'), accountTypes: cf.investing.map((l) => l.type), from, to, mode: 'flow', dims, cashOnly: true }}
              />

              <SectionHeader title={t('sections.financing')} />
              {cf.financing.length === 0 ? (
                <EmptySection />
              ) : (
                cf.financing.map((l) => (
                  <AmountRow
                    key={l.accountId}
                    label={`${l.number ? `${l.number} · ` : ''}${l.name}`}
                    amount={l.amount}
                    m={m}
                    drill={{ kind: 'ledger', label: l.name, accountIds: [l.accountId], from, to, mode: 'flow', dims, cashOnly: true }}
                  />
                ))
              )}
              <SubtotalRow
                label={t('subtotals.financing')}
                amount={cf.financingTotal}
                m={m}
                drill={{ kind: 'ledger', label: t('subtotals.financing'), accountTypes: cf.financing.map((l) => l.type), from, to, mode: 'flow', dims, cashOnly: true }}
              />

              {Math.abs(cf.fxEffectOnCash) >= 0.005 ? (
                <AmountRow label={t('fxEffect')} amount={cf.fxEffectOnCash} m={m} />
              ) : null}

              <TableRow className={reportSubtotalRowClass}>
                <TableCell className="font-bold">{t('netChange')}</TableCell>
                <TableCell className={cn('text-right font-bold tabular-nums', cf.netChange < 0 && 'text-red-600 dark:text-red-400')}>
                  <ReportDrillLink target={{ kind: 'ledger', label: t('netChange'), accountTypes: ['asset_bank'], from, to, mode: 'flow', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(cf.netChange)}</ReportDrillLink>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pl-8 text-slate-500 dark:text-slate-400">{t('openingCash')}</TableCell>
                <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400"><ReportDrillLink target={{ kind: 'ledger', label: t('openingCash'), accountTypes: ['asset_bank'], to: openingDate, mode: 'balance', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(cf.openingCash)}</ReportDrillLink></TableCell>
              </TableRow>
              <TableRow className={reportTotalRowClass}>
                <TableCell className="font-semibold">{t('closingCash')}</TableCell>
                <TableCell className={cn('text-right font-semibold tabular-nums', cf.closingCash < 0 && 'text-red-600 dark:text-red-400')}>
                  <ReportDrillLink target={{ kind: 'ledger', label: t('closingCash'), accountTypes: ['asset_bank'], to, mode: 'balance', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(cf.closingCash)}</ReportDrillLink>
                </TableCell>
              </TableRow>
            </>
          )}
          </TableBody>
        </Table>
      </ReportPaper>
    </ListPageLayout>
  )
}

type Money = (v: number) => string

function SectionHeader({ title }: { title: string }) {
  return (
    <TableRow>
      <TableCell colSpan={2} className="pt-4 pb-1 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:text-slate-300">
        {title}
      </TableCell>
    </TableRow>
  )
}

function SubHeader({ title }: { title: string }) {
  return (
    <TableRow>
      <TableCell colSpan={2} className="pl-4 pt-2 pb-0.5 text-xs font-medium text-slate-500 italic dark:text-slate-400">
        {title}
      </TableCell>
    </TableRow>
  )
}

function EmptySection() {
  return (
    <TableRow>
      <TableCell colSpan={2} className="pl-8 text-slate-300 italic dark:text-slate-600">
        —
      </TableCell>
    </TableRow>
  )
}

function AmountRow({
  label,
  amount,
  m,
  drill,
}: {
  label: string
  amount: number
  m: Money
  drill?: ReportDrillTarget
}) {
  return (
    <TableRow>
      <TableCell className="pl-8">{label}</TableCell>
      <TableCell className={cn('text-right tabular-nums', amount < 0 && 'text-red-600 dark:text-red-400')}>
        {drill ? (
          <ReportDrillLink target={drill} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(amount)}</ReportDrillLink>
        ) : (
          m(amount)
        )}
      </TableCell>
    </TableRow>
  )
}

function SubtotalRow({
  label,
  amount,
  m,
  drill,
}: {
  label: string
  amount: number
  m: Money
  drill?: ReportDrillTarget
}) {
  return (
    <TableRow className={reportSubtotalRowClass}>
      <TableCell className="font-semibold">{label}</TableCell>
      <TableCell className={cn('text-right font-semibold tabular-nums', amount < 0 && 'text-red-600 dark:text-red-400')}>
        {drill ? (
          <ReportDrillLink target={drill} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(amount)}</ReportDrillLink>
        ) : (
          m(amount)
        )}
      </TableCell>
    </TableRow>
  )
}
