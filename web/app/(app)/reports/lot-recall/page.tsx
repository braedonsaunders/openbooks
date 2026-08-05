import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { PageHeader } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { queryLotRecall } from '@openbooks/engine/src/inventory.ts'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../ReportTable'

export const dynamic = 'force-dynamic'

export default async function LotRecallReport({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('reports')
  const authz = await requirePermission('reports.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'inventory'))) notFound()

  const sp = await searchParams
  const lotNumber = typeof sp.lotNumber === 'string' ? sp.lotNumber : undefined
  const itemId = typeof sp.itemId === 'string' ? sp.itemId : undefined
  const expiresOnOrBefore = typeof sp.expiresOnOrBefore === 'string' ? sp.expiresOnOrBefore : undefined

  const rows = await queryLotRecall(authz.user.orgId, {
    lotNumber: lotNumber || undefined,
    itemId: itemId || undefined,
    expiresOnOrBefore: expiresOnOrBefore || undefined,
    includeExpiryOnly: sp.expiring === '1',
  })

  const items = (await db.execute(sql`
    select id, code, name from items where org_id = ${authz.user.orgId} order by code nulls last, name limit 500
  `)) as unknown as { rows: { id: string; code: string | null; name: string }[] }

  return (
    <ListPageLayout
      header={
        <div className="space-y-3">
          <PageHeader title={t('lotRecall.title')} description={t('lotRecall.description')} />
          <form className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('lotRecall.lotNumber')}</span>
              <input name="lotNumber" defaultValue={lotNumber ?? ''} className="h-9 rounded border px-2 dark:border-slate-700 dark:bg-slate-900" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('lotRecall.item')}</span>
              <select name="itemId" defaultValue={itemId ?? ''} className="h-9 rounded border px-2 dark:border-slate-700 dark:bg-slate-900">
                <option value="">{t('lotRecall.anyItem')}</option>
                {items.rows.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.code ? `${i.code} · ` : ''}
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{t('lotRecall.expiresBy')}</span>
              <input
                type="date"
                name="expiresOnOrBefore"
                defaultValue={expiresOnOrBefore ?? ''}
                className="h-9 rounded border px-2 dark:border-slate-700 dark:bg-slate-900"
              />
            </label>
            <button type="submit" className="h-9 rounded bg-teal-700 px-3 text-sm text-white hover:bg-teal-800">
              {t('lotRecall.run')}
            </button>
          </form>
        </div>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('lotRecall.colLot')}</TableHead>
            <TableHead>{t('lotRecall.colExpiry')}</TableHead>
            <TableHead>{t('lotRecall.colItem')}</TableHead>
            <TableHead>{t('lotRecall.colKind')}</TableHead>
            <TableHead>{t('lotRecall.colDate')}</TableHead>
            <TableHead className="text-right">{t('lotRecall.colQty')}</TableHead>
            <TableHead>{t('lotRecall.colLocation')}</TableHead>
            <TableHead>{t('lotRecall.colDoc')}</TableHead>
            <TableHead>{t('lotRecall.colParty')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <td colSpan={9} className="py-8 text-center text-muted-foreground">
                {t('lotRecall.empty')}
              </td>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={`${r.movementId}-${r.lotId}`}>
                <td className="py-1.5 pr-3 font-medium">{r.lotNumber}</td>
                <td className="py-1.5 pr-3">{r.expiresOn ?? '—'}</td>
                <td className="py-1.5 pr-3">{r.itemCode ?? r.itemName ?? '—'}</td>
                <td className="py-1.5 pr-3">{r.kind}</td>
                <td className="py-1.5 pr-3">{String(r.movedAt).slice(0, 10)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{r.quantity}</td>
                <td className="py-1.5 pr-3">{r.locationCode ?? '—'}</td>
                <td className="py-1.5 pr-3">
                  {r.documentId ? (
                    <a className="text-teal-700 hover:underline dark:text-teal-300" href={`/documents/${r.documentId}`}>
                      {r.documentNumber}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="py-1.5">{r.partyName ?? '—'}</td>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
