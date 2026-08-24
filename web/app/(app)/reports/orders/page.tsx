import { getMoneyFormatter } from '@/lib/money-server'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { orgInfo } from '../../../../lib/data'
import { ReportPaper } from '../ReportPaper'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ReportTable'
import { ReportDrillLink } from '../ReportDrillLink'
import { ReportFilterBar } from '../ReportFilterBar'
import { SaveViewButton } from '../SaveViewButton'

export const dynamic = 'force-dynamic'

const KINDS = ['quote', 'sales_order', 'purchase_order'] as const

/**
 * Order pipeline report — open backlog (count + value) and conversion for
 * quotes, sales orders and purchase orders. Conversion moved here from the list
 * pages: it's an analytical roll-up, not a per-row list column. Conversion is
 * derived from document_links (from order → downstream invoice/bill).
 */
export default async function OrdersReport() {
  const { money } = await getMoneyFormatter()
  const authz = await requirePermission('reports.read')
  await requireFeatureEnabled(authz.user.orgId, 'orders')
  const t = await getTranslations('reports.orders')
  const tr = await getTranslations('reports')
  const orgId = authz.user.orgId

  const [pipeline, converted, org] = await Promise.all([
    (db.execute(sql`
      select kind, status, count(*)::int as n, coalesce(sum(total), 0) as value
        from documents
       where org_id = ${orgId} and kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
       group by kind, status`)),
    (db.execute(sql`
      select d.kind, count(distinct d.id)::int as converted
        from documents d
        join document_links dl on dl.from_document_id = d.id and dl.org_id = d.org_id
       where d.org_id = ${orgId} and d.kind in (${sql.join(KINDS.map((k) => sql`${k}`), sql`, `)})
       group by d.kind`)),
    orgInfo(orgId),
  ])

  const convByKind = new Map<string, number>(converted.rows.map((r: any) => [r.kind, Number(r.converted)]))
  const rows = KINDS.map((kind) => {
    const forKind = pipeline.rows.filter((r) => r.kind === kind)
    const openRows = forKind.filter((r) => r.status !== 'voided')
    const open = openRows.reduce((a: number, r) => a + Number(r.n), 0)
    const openValue = openRows.reduce((a: number, r) => a + Number(r.value), 0)
    const voided = forKind.filter((r) => r.status === 'voided').reduce((a: number, r) => a + Number(r.n), 0)
    const conv = convByKind.get(kind) ?? 0
    const denom = open + conv
    return { kind, open, openValue, voided, conv, rate: denom > 0 ? Math.round((conv / denom) * 100) : 0 }
  })

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader back={{ href: '/reports', label: tr('hub.title') }} title={t('title')} description={t('description')} />
          <ReportFilterBar controls={{ period: false }} actions={<SaveViewButton />} />
        </>
      }
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
              {([
                ['open', r.open.toLocaleString('en-CA')],
                ['open', money(r.openValue)],
                ['converted', r.conv.toLocaleString('en-CA')],
                ['conversion', `${r.rate}%`],
                ['voided', r.voided.toLocaleString('en-CA')],
              ] as const).map(([scope, value], index) => (
                <TableCell key={index} className="text-right tabular-nums">
                  <ReportDrillLink
                    target={{ kind: 'orders', orderKind: r.kind, scope, label: `${t(`kinds.${r.kind}`)} · ${t(`columns.${index === 0 ? 'open' : index === 1 ? 'openValue' : index === 2 ? 'converted' : index === 3 ? 'convRate' : 'voided'}`)}` }}
                    className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
                  >
                    {value}
                  </ReportDrillLink>
                </TableCell>
              ))}
            </TableRow>
          ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{t('note')}</p>
      </ReportPaper>
    </ListPageLayout>
  )
}
