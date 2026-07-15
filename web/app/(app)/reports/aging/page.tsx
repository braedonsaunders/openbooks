import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Badge, Card, CardContent, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { agingByParty, dimensionOptions, type AgingSide } from '../../../../lib/reports'
import { money } from '../../../../lib/format'
import { DimensionFilter } from '../DimensionFilter'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const BUCKETS = ['current', 'b1', 'b2', 'b3', 'b4'] as const

export default async function Aging({
  searchParams,
}: {
  searchParams: Promise<{ side?: string; asof?: string; dept?: string; project?: string }>
}) {
  const t = await getTranslations('reports.aging')
  const tr = await getTranslations('reports')
  const tc = await getTranslations('common')
  const sp = await searchParams
  const side: AgingSide = sp.side === 'ap' ? 'ap' : 'ar'
  const asOf = sp.asof ?? new Date().toISOString().slice(0, 10)
  const dims = { departmentId: sp.dept || undefined, projectId: sp.project || undefined }
  const [aging, opts] = await Promise.all([agingByParty(side, asOf, dims), dimensionOptions()])
  const keepDims = `dept=${sp.dept ?? ''}&project=${sp.project ?? ''}`

  const bucketLabels: Record<(typeof BUCKETS)[number], string> = {
    current: t('buckets.current'),
    b1: t('buckets.b1'),
    b2: t('buckets.b2'),
    b3: t('buckets.b3'),
    b4: t('buckets.b4'),
  }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={side === 'ap' ? t('payablesTitle') : t('receivablesTitle')}
            description={t('asOf', { date: asOf })}
            back={{ href: '/reports', label: tr('hub.title') }}
            actions={<SaveViewButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/reports/aging?side=ar&asof=${asOf}&${keepDims}`}>
              <Badge variant={side === 'ar' ? 'default' : 'outline'}>{t('receivables')}</Badge>
            </Link>
            <Link href={`/reports/aging?side=ap&asof=${asOf}&${keepDims}`}>
              <Badge variant={side === 'ap' ? 'default' : 'outline'}>{t('payables')}</Badge>
            </Link>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <DimensionFilter departments={opts.departments} projects={opts.projects} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card>
              <CardContent className="p-4">
                <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                  {t('columns.total')}
                </span>
                <span className="block text-xl font-semibold tabular-nums">{money(aging.totals.total)}</span>
              </CardContent>
            </Card>
            {BUCKETS.map((b) => (
              <Card key={b}>
                <CardContent className="p-4">
                  <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
                    {bucketLabels[b]}
                  </span>
                  <span className="block text-xl font-semibold tabular-nums">{money(aging.totals[b])}</span>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tc('labels.party')}</TableHead>
            {BUCKETS.map((b) => (
              <TableHead key={b} className="text-right">
                {bucketLabels[b]}
              </TableHead>
            ))}
            <TableHead className="text-right">{t('columns.total')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {aging.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={BUCKETS.length + 2} className="text-center text-slate-400 italic">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            aging.rows.map((r, i) => (
              <TableRow key={r.partyId ?? `none-${i}`}>
                <TableCell>
                  {r.partyId ? (
                    <Link href={`/parties/${r.partyId}`} className="hover:text-teal-700 dark:hover:text-teal-300">
                      {r.partyName ?? t('noParty')}
                    </Link>
                  ) : (
                    <span className="text-slate-400 italic">{t('noParty')}</span>
                  )}
                </TableCell>
                {BUCKETS.map((b) => (
                  <TableCell
                    key={b}
                    className={cn('text-right tabular-nums', r[b] < 0 && 'text-red-600 dark:text-red-400')}
                  >
                    {r[b] !== 0 ? money(r[b]) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                  </TableCell>
                ))}
                <TableCell className="text-right font-semibold tabular-nums">{money(r.total)}</TableCell>
              </TableRow>
            ))
          )}
          {aging.rows.length > 0 ? (
            <TableRow>
              <TableCell className="font-bold">{tr('trialBalance.totals')}</TableCell>
              {BUCKETS.map((b) => (
                <TableCell key={b} className="text-right font-bold tabular-nums">
                  {money(aging.totals[b])}
                </TableCell>
              ))}
              <TableCell className="text-right font-bold tabular-nums">{money(aging.totals.total)}</TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
