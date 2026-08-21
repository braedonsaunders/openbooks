import { getMoneyFormatter } from '@/lib/money-server'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, PageHeader, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { Pagination } from '../../../../components/pagination'
import { parseListParams } from '../../../../lib/list-params'
import { partnerBalances } from '../../../../lib/reports'
import { orgInfo } from '../../../../lib/data'
import { ExportMenu } from '../ExportMenu'
import { SaveViewButton } from '../SaveViewButton'
import { ScheduleReportButton } from '../ScheduleReportButton'
import { reportScheduleAnchor, scheduleParamsFrom } from '../../../../lib/report-schedule-anchor'
import { ReportPaper } from '../ReportPaper'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ReportTable'
import { ReportDrillLink } from '../ReportDrillLink'
import { ReportFilterBar } from '../ReportFilterBar'
import { decimalCmp, decimalNeg, decimalSum } from '../../../../lib/statement-format'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { resolveOrgId } from '../../../../lib/org-scope'

export const dynamic = 'force-dynamic'
const PER_PAGE = 50

export default async function Partners({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const t = await getTranslations('reports.partners')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const scheduleDefId = await reportScheduleAnchor('partners', { kind: sp.kind === 'payable' ? 'payable' : 'receivable' })
  const k = sp.kind === 'receivable' ? 'receivable' : 'payable'
  const params = parseListParams(sp, { sort: 'balance', allowedSorts: ['balance'] as const, perPage: PER_PAGE })
  const [all, org] = await Promise.all([partnerBalances(k), orgInfo()])
  const m = (v: string) => money(Number(v), { currency: org?.base_currency })
  const q = params.q?.toLowerCase()
  const filtered = q ? all.filter((r) => (r.display_name ?? '').toLowerCase().includes(q)) : all
  const presented = (value: string) => k === 'payable' ? decimalNeg(value) : value
  const total = presented(decimalSum(filtered.map((row) => row.balance)))
  const rows = filtered.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE)
  const asOf = await businessToday(await resolveOrgId())
  const accountTypes = [k === 'payable' ? 'liability_payable' : 'asset_receivable']

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={k === 'payable' ? t('payablesTitle') : t('receivablesTitle')}
            back={{ href: '/reports', label: tr('hub.title') }}
          />
          <ReportFilterBar
            controls={{ search: true, period: false }}
            searchPlaceholder={t('searchPlaceholder')}
            leading={
              <>
                <Link href="/reports/partners?kind=payable">
                  <Badge variant={k === 'payable' ? 'default' : 'outline'}>{t('payables')}</Badge>
                </Link>
                <Link href="/reports/partners?kind=receivable">
                  <Badge variant={k === 'receivable' ? 'default' : 'outline'}>{t('receivables')}</Badge>
                </Link>
              </>
            }
            actions={<>{scheduleDefId ? <ScheduleReportButton definitionId={scheduleDefId} statementParams={scheduleParamsFrom(sp)} /> : null}<SaveViewButton /><ExportMenu kind="partners" params={{ ...sp, side: k }} /></>}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('totalOutstanding')}: <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200"><ReportDrillLink target={{ kind: 'ledger', label: t('totalOutstanding'), accountTypes, to: asOf, mode: 'balance' }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(total)}</ReportDrillLink></span>
          </p>
        </>
      }
    >
      <ReportPaper
        company={org?.name ?? ''}
        title={k === 'payable' ? t('payablesTitle') : t('receivablesTitle')}
        periodPhrase={t('description')}
      >
        <Table>
          <TableHeader>
          <TableRow>
            <TableHead>{tc('labels.party')}</TableHead>
            <TableHead className="text-right">{t('columns.outstanding')}</TableHead>
            <TableHead className="text-right">{t('columns.glLines')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.id ?? `none-${i}`}>
              <TableCell>
                {r.display_name ?? <span className="text-slate-400 italic">{t('noPartyOnLines')}</span>}
              </TableCell>
              <TableCell
                className={cn('text-right tabular-nums', decimalCmp(presented(r.balance), '0') < 0 && 'text-red-600 dark:text-red-400')}
              >
                <ReportDrillLink target={{ kind: 'ledger', label: r.display_name ?? t('noPartyOnLines'), accountTypes, partyIds: r.id ? [r.id] : undefined, to: asOf, mode: 'balance' }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{m(presented(r.balance))}</ReportDrillLink>
              </TableCell>
              <TableCell className="text-right tabular-nums"><ReportDrillLink target={{ kind: 'ledger', label: r.display_name ?? t('noPartyOnLines'), accountTypes, partyIds: r.id ? [r.id] : undefined, to: asOf, mode: 'balance' }} className="hover:text-teal-700 hover:underline dark:hover:text-teal-300">{r.line_count}</ReportDrillLink></TableCell>
            </TableRow>
          ))}
          </TableBody>
        </Table>
        <div className="mt-3">
          <Pagination basePath="/reports/partners" currentParams={sp} total={filtered.length} page={params.page} perPage={PER_PAGE} />
        </div>
      </ReportPaper>
    </ListPageLayout>
  )
}
