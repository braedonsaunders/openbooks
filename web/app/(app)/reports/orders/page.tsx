import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { money } from '../../../../lib/format'
import { orgInfo } from '../../../../lib/data'
import { ReportPaper } from '../ReportPaper'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ReportTable'

export const dynamic = 'force-dynamic'

const KINDS = ['quote', 'sales_order', 'purchase_order'] as const

/**
 * Order pipeline report — open backlog (count + value) and conversion for
 * quotes, sales orders and purchase orders. Conversion moved here from the list
 * pages: it's an analytical roll-up, not a per-row list column. Conversion is
 * derived from document_links (from order → downstream invoice/bill).
 */
export default async function OrdersReport() {
  const authz = await requirePermission('reports.read')
  const t = await getTranslations('reports.orders')
  const tr = await getTranslations('reports')
  const orgId = authz.user.orgId

  const [pipeline, converted, org] = await Promise.all([
    db.execute(sql`
      select kind, status, count(*)::int as n, coalesce(sum(total), 0) as value
        from documents
       where org_id = ${orgId} and kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
       group by kind, status`) as any,
    db.execute(sql`
      select d.kind, count(distinct d.id)::int as converted
        from documents d
        join document_links dl on dl.from_document_id = d.id
       where d.org_id = ${orgId} and d.kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
       group by d.kind`) as any,
    orgInfo(orgId),
  ])

  const convByKind = new Map<string, number>(converted.rows.map((r: any) => [r.kind, Number(r.converted)]))
  const rows = KINDS.map((kind) => {
    const forKind = pipeline.rows.filter((r: any) => r.kind === kind)
    const openRows = forKind.filter((r: any) => r.status !== 'voided')
    const open = openRows.reduce((a: number, r: any) => a + Number(r.n), 0)
    const openValue = openRows.reduce((a: number, r: any) => a + Number(r.value), 0)
    const voided = forKind.filter((r: any) => r.status === 'voided').reduce((a: number, r: any) => a + Number(r.n), 0)
    const conv = convByKind.get(kind) ?? 0
    const denom = open + conv
    return { kind, open, openValue, voided, conv, rate: denom > 0 ? Math.round((conv / denom) * 100) : 0 }
  })

  return (
    <ListPageLayout
      header={<PageHeader back={{ href: '/reports', label: tr('hub.title') }} title={t('title')} description={t('description')} />}
    >
      <ReportPaper company={org?.name ?? ''} title={t('title')} periodPhrase={t('description')} wide>
        <Table>
          <TableHeader>
          <TableRow>
            <TableHead>{t('columns.type')}</TableHead>
            <TableHead className="text-right">{t('columns.open')}</TableHead>
            <TableHead className="text-right">{t('columns.openValue')}</TableHead>
            <TableHead className="text-right">{t('columns.converted')}</TableHead>
            <TableHead className="text-right">{t('columns.convRate')}</TableHead>
            <TableHead className="text-right">{t('columns.voided')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.kind}>
              <TableCell className="font-medium">{t(`kinds.${r.kind}`)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.open.toLocaleString('en-CA')}</TableCell>
              <TableCell className="text-right tabular-nums">{money(r.openValue)}</TableCell>
              <TableCell className="text-right tabular-nums">{r.conv.toLocaleString('en-CA')}</TableCell>
              <TableCell className="text-right tabular-nums text-slate-500 dark:text-slate-400">{r.rate}%</TableCell>
              <TableCell className="text-right tabular-nums text-slate-400">{r.voided.toLocaleString('en-CA')}</TableCell>
            </TableRow>
          ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{t('note')}</p>
      </ReportPaper>
    </ListPageLayout>
  )
}
