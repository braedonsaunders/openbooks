import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Card, CardContent, CardDescription, CardTitle, PageHeader, Table, TableBody, TableCell, TableRow } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'
import { currentFiscalYearEnd, fiscalYearRange } from '../../../lib/reports'

export const dynamic = 'force-dynamic'

async function savedViews() {
  const r = (await db.execute(sql`
    select id, name, path, params from saved_reports order by created_at desc limit 50`)) as any
  return r.rows as { id: string; name: string; path: string; params: Record<string, string> }[]
}

export default async function Reports() {
  const t = await getTranslations('reports')
  const saved = await savedViews()
  const fy = await currentFiscalYearEnd()
  const cur = await fiscalYearRange(fy)
  const today = new Date().toISOString().slice(0, 10)

  const reports = [
    { href: `/reports/pnl?from=${cur.from}&to=${cur.to}`, title: t('hub.cards.pnlTitle'), desc: t('hub.cards.pnlDescription', { fyLabel: cur.label }) },
    { href: `/reports/balance-sheet?asof=${today}`, title: t('hub.cards.balanceSheetTitle'), desc: t('hub.cards.balanceSheetDescription') },
    { href: `/reports/trial-balance?asof=${today}`, title: t('hub.cards.trialBalanceTitle'), desc: t('hub.cards.trialBalanceDescription') },
    { href: `/reports/partners?kind=payable`, title: t('hub.cards.payablesTitle'), desc: t('hub.cards.payablesDescription') },
    { href: `/reports/partners?kind=receivable`, title: t('hub.cards.receivablesTitle'), desc: t('hub.cards.receivablesDescription') },
  ]

  return (
    <PageContainer>
      <PageHeader
        title={t('hub.title')}
        description={t('hub.description')}
      />
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {reports.map((r) => (
          <Link key={r.href} href={r.href}>
            <Card interactive className="h-full">
              <CardContent className="space-y-1.5 p-5">
                <CardTitle className="text-base">{r.title}</CardTitle>
                <CardDescription>{r.desc}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {saved.length > 0 ? (
        <>
          <h2 className="mt-8 mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">{t('hub.savedViews')}</h2>
          <Table>
            <TableBody>
              {saved.map((s) => {
                const qs = new URLSearchParams(s.params ?? {}).toString()
                return (
                  <TableRow key={s.id}>
                    <TableCell>
                      <Link
                        href={`${s.path}${qs ? `?${qs}` : ''}`}
                        className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {s.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      {s.path}
                      {qs ? `?${qs}` : ''}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </>
      ) : null}
    </PageContainer>
  )
}
