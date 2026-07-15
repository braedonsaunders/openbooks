import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { cashFlow, currentFiscalYearEnd, dimensionOptions, fiscalYearRange, type CashFlowSection } from '../../../../lib/reports'
import { money } from '../../../../lib/format'
import { DimensionFilter } from '../DimensionFilter'
import { StatementExport } from '../StatementExport'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const SECTION_ORDER: CashFlowSection[] = ['operating', 'investing', 'financing']

export default async function CashFlow({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; dept?: string; project?: string }>
}) {
  const t = await getTranslations('reports.cashFlow')
  const tr = await getTranslations('reports')
  const sp = await searchParams
  const fyNow = await currentFiscalYearEnd()
  // Same FY presets as the P&L — driven by the org's configured fiscal-year
  // start month, so the two statements always share a period.
  const fyPresets = await Promise.all([fyNow, fyNow - 1, fyNow - 2].map((y) => fiscalYearRange(y)))
  const def = fyPresets[0]
  const from = sp.from ?? def.from
  const to = sp.to ?? def.to
  const dims = { departmentId: sp.dept || undefined, projectId: sp.project || undefined }
  const [cf, opts] = await Promise.all([cashFlow(from, to, dims), dimensionOptions()])
  const keepDims = `dept=${sp.dept ?? ''}&project=${sp.project ?? ''}`

  const sectionLabels: Record<CashFlowSection, string> = {
    operating: t('sections.operating'),
    investing: t('sections.investing'),
    financing: t('sections.financing'),
  }
  const reconciled = Math.abs(cf.reconciliationGap) < 0.01
  const hasMovements = cf.sections.some((s) => s.lines.length > 0)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t('title')}
            description={t('dateRange', { from, to })}
            back={{ href: '/reports', label: tr('hub.title') }}
            actions={<><SaveViewButton /><StatementExport kind="cash-flow" params={{ from, to, dept: sp.dept, project: sp.project }} /></>}
          />
          <div className="flex flex-wrap items-center gap-2">
            {fyPresets.map((r) => {
              const active = from === r.from && to === r.to
              return (
                <Link key={r.label} href={`/reports/cash-flow?from=${r.from}&to=${r.to}&${keepDims}`}>
                  <Badge variant={active ? 'default' : 'outline'}>{r.label}</Badge>
                </Link>
              )
            })}
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <DimensionFilter departments={opts.departments} projects={opts.projects} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('openingCash')} value={cf.openingCash} />
            <Stat label={t('netChange')} value={cf.netChange} tone={cf.netChange >= 0 ? 'good' : 'bad'} />
            <Stat label={t('closingCash')} value={cf.closingCash} />
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  {t('reconciliation')}
                </span>
                <span className="mt-1 inline-block">
                  <Badge variant={reconciled ? 'success' : 'destructive'}>
                    {reconciled ? t('reconciled') : t('offBy', { amount: money(cf.reconciliationGap) })}
                  </Badge>
                </span>
              </CardContent>
            </Card>
          </div>
        </>
      }
    >
      <Table>
        <TableBody>
          {!hasMovements ? (
            <TableRow>
              <TableCell colSpan={2} className="text-center text-slate-400 italic">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            SECTION_ORDER.map((section) => {
              const s = cf.sections.find((x) => x.section === section)!
              return (
                <SectionRows
                  key={section}
                  title={sectionLabels[section]}
                  subtotalLabel={t('subtotal', { section: sectionLabels[section].toLowerCase() })}
                  lines={s.lines}
                  subtotal={s.subtotal}
                />
              )
            })
          )}
          {hasMovements ? (
            <>
              <TableRow>
                <TableCell className="font-bold">{t('netChange')}</TableCell>
                <TableCell className={cn('text-right font-bold tabular-nums', cf.netChange < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(cf.netChange)}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="pl-8 text-slate-500 dark:text-slate-400">{t('openingCash')}</TableCell>
                <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">{money(cf.openingCash)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-semibold">{t('closingCash')}</TableCell>
                <TableCell className={cn('text-right font-semibold tabular-nums', cf.closingCash < 0 && 'text-red-600 dark:text-red-400')}>
                  {money(cf.closingCash)}
                </TableCell>
              </TableRow>
            </>
          ) : null}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</span>
        <span
          className={cn(
            'block text-xl font-semibold tabular-nums',
            tone === 'good' && 'text-teal-700 dark:text-teal-300',
            tone === 'bad' && 'text-red-600 dark:text-red-400',
          )}
        >
          {money(value)}
        </span>
      </CardContent>
    </Card>
  )
}

function SectionRows({
  title,
  subtotalLabel,
  lines,
  subtotal,
}: {
  title: string
  subtotalLabel: string
  lines: { type: string; label: string; amount: number }[]
  subtotal: number
}) {
  return (
    <>
      <TableRow>
        <TableCell
          colSpan={2}
          className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300"
        >
          {title}
        </TableCell>
      </TableRow>
      {lines.length === 0 ? (
        <TableRow>
          <TableCell colSpan={2} className="pl-8 text-slate-300 italic dark:text-slate-600">
            —
          </TableCell>
        </TableRow>
      ) : (
        lines.map((l) => (
          <TableRow key={l.type}>
            <TableCell className="pl-8">{l.label}</TableCell>
            <TableCell className={cn('text-right tabular-nums', l.amount < 0 && 'text-red-600 dark:text-red-400')}>
              {money(l.amount)}
            </TableCell>
          </TableRow>
        ))
      )}
      <TableRow>
        <TableCell className="font-semibold">{subtotalLabel}</TableCell>
        <TableCell className={cn('text-right font-semibold tabular-nums', subtotal < 0 && 'text-red-600 dark:text-red-400')}>
          {money(subtotal)}
        </TableCell>
      </TableRow>
    </>
  )
}
