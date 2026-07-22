import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { SETUP_ENTITY_BY_KEY, OVERHEAD_RATE_KINDS } from '../../../../../lib/setup/registry'
import { NewSetupButton, SetupDrawer } from '../[entity]/SetupDrawer'
import { getMoneyFormatter } from '@/lib/money-server'

/**
 * Overhead Rates — the published, effective-dated department rate card, hosted
 * as an in-page subtab of the Overhead workspace (rather than a separate Setup
 * nav entry) so the model and its rates live in one place. Reuses the generic
 * SetupDrawer for create/edit/delete; only the list rendering is bespoke because
 * the shape is small (department · rate · effective window) and we want a
 * currency/percent-aware display of the single `ratePercent` value.
 */

const HOST = '/admin/setup/overhead'
const CLOSE = `${HOST}?view=rates`

type Row = {
  id: string
  department_id: string | null
  department_name: string | null
  rate_kind: string | null
  rate_percent: string | number | null
  effective_from: string | null
  effective_to: string | null
}

export async function RatesTab({ orgId, rowParam }: { orgId: string; rowParam: string | null }) {
  const { money, locale } = await getMoneyFormatter(orgId)
  const t = await getTranslations('admin.setup')
  const entity = SETUP_ENTITY_BY_KEY.get('overhead-rates')!

  const [ratesRes, deptRes] = await Promise.all([
    db.execute(sql`
      select o.id, o.department_id, d.name as department_name,
             o.rate_kind, o.rate_percent, o.effective_from::text, o.effective_to::text
        from overhead_rates o
        left join departments d on d.id = o.department_id
       where o.org_id = ${orgId}
       order by d.name nulls last, o.effective_from desc`),
    db.execute(sql`
      select id as value, name as label from departments
       where org_id = ${orgId} and is_active order by name`),
  ])
  const rows = (ratesRes as unknown as { rows: Row[] }).rows
  const departments = (deptRes as unknown as { rows: { value: string; label: string }[] }).rows

  const open =
    rowParam === 'new'
      ? { creating: true, row: null as Record<string, any> | null }
      : rowParam
        ? await (async () => {
            const r = (await db.execute(sql`
              select * from overhead_rates where id = ${rowParam} and org_id = ${orgId}`)) as unknown as {
              rows: Record<string, any>[]
            }
            return r.rows[0] ? { creating: false, row: r.rows[0] } : null
          })()
        : null

  const fmtRate = (r: Row) => {
    const v = Number(r.rate_percent ?? 0)
    return r.rate_kind === 'percent'
      ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(v / 100)
      : `${money(v)}/hr`
  }
  const kindLabel = (k: string | null) => {
    const opt = OVERHEAD_RATE_KINDS.find((o) => o.value === k)
    return opt ? t(opt.labelKey) : (k ?? '')
  }
  const fmtDate = (d: string | null) => (d ? d : '—')

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          {t('entities.overhead-rates.description')}
        </p>
        <NewSetupButton entityKey="overhead-rates" label={t('new')} basePath={HOST} />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('fields.departmentId')}</TableHead>
              <TableHead>{t('fields.rateKind')}</TableHead>
              <TableHead>{t('fields.ratePercent')}</TableHead>
              <TableHead>{t('fields.effectiveFrom')}</TableHead>
              <TableHead>{t('fields.effectiveTo')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-slate-500 dark:text-slate-400">
                  {t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`${HOST}?view=rates&row=${r.id}`}
                      className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                    >
                      {r.department_name ?? '—'}
                    </Link>
                  </TableCell>
                  <TableCell>{kindLabel(r.rate_kind)}</TableCell>
                  <TableCell className="tabular-nums">{fmtRate(r)}</TableCell>
                  <TableCell className="tabular-nums">{fmtDate(r.effective_from)}</TableCell>
                  <TableCell className="tabular-nums">{fmtDate(r.effective_to)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {open ? (
        <SetupDrawer
          entity={entity}
          row={open.row}
          members={[]}
          refOptions={{ departments }}
          closeHref={CLOSE}
        />
      ) : null}
    </div>
  )
}
