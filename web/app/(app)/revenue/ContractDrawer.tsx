'use client'

import { useMoney } from '@/components/money-provider'
import { useTranslations } from 'next-intl'
import { Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { RunRecognitionButton } from './RunRecognitionButton'
import type { ContractPayload } from './_lib'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  active: 'success',
  complete: 'secondary',
  draft: 'outline',
  cancelled: 'warning',
  open: 'success',
  satisfied: 'secondary',
}

/**
 * Read-only drill-down for a revenue contract: its performance obligations and,
 * per obligation, the primary-book recognition schedule (planned vs recognized,
 * with the posted period entries). Recognition is driven by invoices + the Run
 * action, so this surface reads rather than edits.
 */
export function ContractDrawer({ payload, canRun, closeHref = '/revenue' }: { payload: ContractPayload; canRun: boolean; closeHref?: string }) {
  const { money } = useMoney()
  const t = useTranslations('revenue')
  const tCommon = useTranslations('common')
  const c = payload.contract

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{c.contract_number}</span>
          <Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>{t(`status.${c.status}`)}</Badge>
        </span>
      }
      description={c.customer}
    >
      <div className="space-y-6 p-1">
        {/* -- summary ------------------------------------------------- */}
        <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label={t('labels.total')} value={money(c.total_transaction_price)} />
          <Stat label={t('drawer.obligations')} value={String(payload.obligations.length)} />
          <Stat
            label={t('labels.recognized')}
            value={money(payload.obligations.reduce((a, o) => a + Number(o.recognized), 0).toFixed(4))}
          />
          <Stat
            label={t('labels.deferred')}
            value={money(
              payload.obligations.reduce((a, o) => a + (Number(o.planned) - Number(o.recognized)), 0).toFixed(4),
            )}
          />
        </section>

        {/* -- obligations + schedules -------------------------------- */}
        {payload.obligations.map((o) => (
          <section key={o.id} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{o.description}</span>
                <Badge variant={STATUS_VARIANT[o.status] ?? 'secondary'}>{t(`obligationStatus.${o.status}`)}</Badge>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {t(`method.${o.method}`)} · {money(o.allocated_price)}
                </span>
                {o.fair_value_flag ? (
                  <Badge variant="warning">
                    {t('drawer.fairValueOutOfRange', {
                      low: o.fair_value_low != null ? money(o.fair_value_low) : '—',
                      high: o.fair_value_high != null ? money(o.fair_value_high) : '—',
                    })}
                  </Badge>
                ) : null}
              </div>
              {canRun ? <RunRecognitionButton obligationId={o.id} /> : null}
            </div>
            {o.lines.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.noSchedule')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('drawer.period')}</TableHead>
                    <TableHead className="text-right">{t('drawer.planned')}</TableHead>
                    <TableHead className="text-right">{t('drawer.recognized')}</TableHead>
                    <TableHead>{tCommon('labels.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {o.lines.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell>{l.period_name}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.planned_amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {l.journal_entry_id ? money(l.recognized_amount) : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={l.journal_entry_id ? 'success' : 'outline'}>
                          {l.journal_entry_id ? t('drawer.postedStatus') : t('drawer.plannedStatus')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        ))}
      </div>
    </UrlDrawer>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}
