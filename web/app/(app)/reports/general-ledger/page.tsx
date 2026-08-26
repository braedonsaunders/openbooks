import { getMoneyFormatter } from '@/lib/money-server'
import { getTranslations } from 'next-intl/server'
import { PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { DocTypeBadge } from '../../../../components/doc-type-badge'
import { dimensionOptions, generalLedger } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { resolvePeriod } from '../../../../lib/periods'
import { parseReportQuery } from '../../../../lib/report-filters'
import { ReportFilterBar } from '../ReportFilterBar'
import { ExportMenu } from '../ExportMenu'
import { TxnLink } from '../TxnLink'
import { SaveViewButton } from '../SaveViewButton'
import { ScheduleReportButton } from '../ScheduleReportButton'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { ReportPaper } from '../ReportPaper'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, reportTotalRowClass } from '../ReportTable'
import { ReportDrillLink } from '../ReportDrillLink'
import { AccountRegisterLink } from '../../../../components/account-register-link'
import { decimalCmp, decimalIsZero } from '../../../../lib/statement-format'

export const dynamic = 'force-dynamic'

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const scheduleDefId = await reportScheduleAnchor('general-ledger')
  const q = parseReportQuery(sp)
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to })
  const dims = q.dims
  const [gl, opts, org] = await Promise.all([
    generalLedger(period.from, period.to, { accountId: sp.account, dims }),
    dimensionOptions(undefined, dims.projectId),
    orgInfo(),
  ])
  const m = (v: string) => money(v, { currency: org?.base_currency })
  const openingTo = new Date(`${period.from}T00:00:00Z`)
  openingTo.setUTCDate(openingTo.getUTCDate() - 1)
  const openingDate = openingTo.toISOString().slice(0, 10)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('generalLedger.title')}
            back={{ href: '/reports', label: t('hub.title') }}
          />
          <ReportFilterBar
            controls={{ period: true, dimensions: true }}
            dimensions={opts}
            actions={<>{scheduleDefId ? <ScheduleReportButton definitionId={scheduleDefId} statementParams={scheduleParamsFrom(sp)} /> : null}<SaveViewButton /><ExportMenu kind="general-ledger" params={sp} /></>}
          />
          {gl.truncated && <p className="text-xs text-amber-600 dark:text-amber-400">{t('generalLedger.truncated')}</p>}
        </>
      }
    >
      <ReportPaper company={org?.name ?? ''} title={t('generalLedger.title')} periodPhrase={t('pnl.dateRange', { from: period.from, to: period.to })} wide>
        {gl.accounts.length === 0 ? (
          <p className="py-8 text-center text-slate-400 italic">{t('generalLedger.empty')}</p>
        ) : (
          <div className="space-y-8">
          {gl.accounts.map((a) => (
            <div key={a.id}>
              <h3 className="mb-1 flex items-baseline gap-2 text-sm font-semibold">
                <AccountRegisterLink accountId={a.id} from={period.from} to={period.to} className="hover:text-teal-700 dark:hover:text-teal-300">
                  <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{a.number}</span>
                  {a.name}
                </AccountRegisterLink>
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">{t('generalLedger.columns.date')}</TableHead>
                    <TableHead className="w-24">{t('generalLedger.columns.entry')}</TableHead>
                    <TableHead>{t('generalLedger.columns.detail')}</TableHead>
                    <TableHead className="text-right">{t('trialBalance.columns.debits')}</TableHead>
                    <TableHead className="text-right">{t('trialBalance.columns.credits')}</TableHead>
                    <TableHead className="text-right">{tc('labels.balance')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={5} className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {t('generalLedger.opening')}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums"><ReportDrillLink target={{ kind: 'ledger', label: `${a.name} · ${t('generalLedger.opening')}`, accountIds: [a.id], to: openingDate, mode: 'balance', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(a.opening)}</ReportDrillLink></TableCell>
                  </TableRow>
                  {a.lines.map((l, i) => (
                    <TableRow key={`${l.entryId}-${i}`}>
                      <TableCell className="tabular-nums">{l.date}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="font-mono text-xs hover:text-teal-700 dark:hover:text-teal-300">
                            {l.entryNumber}
                          </TxnLink>
                          {l.docKind && <DocTypeBadge kind={l.docKind} icon={false} />}
                        </span>
                      </TableCell>
                      <TableCell className="text-slate-600 dark:text-slate-300">
                        {[l.party, l.memo].filter(Boolean).join(' · ')}
                      </TableCell>
                      <TableCell className="text-right tabular-nums"><TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{!decimalIsZero(l.debit) ? m(l.debit) : ''}</TxnLink></TableCell>
                      <TableCell className="text-right tabular-nums"><TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{!decimalIsZero(l.credit) ? m(l.credit) : ''}</TxnLink></TableCell>
                      <TableCell className={cn('text-right tabular-nums', decimalCmp(l.balance, '0') < 0 && 'text-red-600 dark:text-red-400')}>
                        <TxnLink entryId={l.entryId} docKind={l.docKind} docId={l.docId} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(l.balance)}</TxnLink>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className={reportTotalRowClass}>
                    <TableCell colSpan={5} className="text-xs font-semibold">
                      {t('generalLedger.closing')}
                    </TableCell>
                    <TableCell className={cn('text-right font-semibold tabular-nums', decimalCmp(a.closing, '0') < 0 && 'text-red-600 dark:text-red-400')}>
                      <ReportDrillLink target={{ kind: 'ledger', label: `${a.name} · ${t('generalLedger.closing')}`, accountIds: [a.id], to: period.to, mode: 'balance', dims }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(a.closing)}</ReportDrillLink>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ))}
          </div>
        )}
      </ReportPaper>
    </ListPageLayout>
  )
}
