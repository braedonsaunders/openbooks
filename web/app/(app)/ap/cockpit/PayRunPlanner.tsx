'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowRight, ShieldCheck, Gauge, TriangleAlert, SlidersHorizontal } from 'lucide-react'
import { Badge, Button, cn } from '@openbooks/ui'
import { money } from '../../../../lib/format'
import { compactMoney } from '../../../../components/cockpit/ui'

export interface PlannerEntry {
  id: string
  docId: string | null
  docKind: string | null
  partyName: string
  amount: number
  dueDate: string | null
  daysOverdue: number
  method: string
}

export interface PayRunPlannerProps {
  recommended: PlannerEntry[]
  capacity: number | null
  startingCash: number
  weeklyCap: number
  restrictToSafe: boolean
  scheduling: boolean
  deferredThisWeek: number
  deferredBeyondHorizon: number
  /** admin.setup.manage — gates editing the AP-to-pay selection settings. */
  canConfigure: boolean
}

const fmtDate = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

/**
 * The AP pay-run planner: the capacity-scheduled recommendation for this week.
 * Bills are pre-selected; the user can trim the set, watch the total against
 * the week's capacity, then hand the selection to the /payments run builder
 * (which owns bank account, discount capture and credit application).
 *
 * The selection rule itself (weekly cap + restrict-to-safe) is configurable
 * inline — it persists to the shared cashflow config so the forecast and the
 * planner always agree.
 */
export function PayRunPlanner(props: PayRunPlannerProps) {
  const t = useTranslations('ap.cockpit.payRun')
  const router = useRouter()
  // Only bills with a source document can be routed into a payment run.
  const payable = useMemo(() => props.recommended.filter((e) => e.docId), [props.recommended])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(payable.map((e) => e.id)))
  const [showSettings, setShowSettings] = useState(false)

  const selectedEntries = payable.filter((e) => selected.has(e.id))
  const total = selectedEntries.reduce((a, e) => a + e.amount, 0)
  const cap = props.capacity
  const overCap = cap !== null && total > cap + 0.005
  const pct = cap && cap > 0 ? Math.min(100, (total / cap) * 100) : total > 0 ? 100 : 0

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const build = () => {
    const ids = selectedEntries.map((e) => e.docId!).filter(Boolean)
    if (!ids.length) return
    router.push(`/payments?view=runs&newRun=1&preselect=${ids.join(',')}` as any)
  }

  return (
    <div className="flex h-full flex-col">
      {/* capacity meter */}
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium text-slate-500 dark:text-slate-400">
            {props.restrictToSafe ? <ShieldCheck size={13} /> : <Gauge size={13} />}
            {cap === null ? t('noCap') : props.restrictToSafe ? t('safeCapacity') : t('weeklyCap')}
          </span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-slate-600 dark:text-slate-300">
              {money(total)}
              {cap !== null ? <span className="text-slate-400"> / {money(cap)}</span> : null}
            </span>
            {props.canConfigure ? (
              <button
                type="button"
                onClick={() => setShowSettings((s) => !s)}
                title={t('settings.title')}
                className={cn('rounded p-0.5 transition-colors', showSettings ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200')}
              >
                <SlidersHorizontal size={13} />
              </button>
            ) : null}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div
            className={cn('h-full rounded-full transition-all', overCap ? 'bg-red-500' : 'bg-teal-500')}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px]">
          <span className="text-slate-400 dark:text-slate-500">{t('startingCash', { amount: money(props.startingCash) })}</span>
          {overCap ? (
            <span className="flex items-center gap-1 font-medium text-red-600 dark:text-red-400"><TriangleAlert size={11} />{t('overCap')}</span>
          ) : props.deferredThisWeek > 0 ? (
            <span className="text-amber-600 dark:text-amber-400">{t('deferred', { amount: compactMoney(props.deferredThisWeek) })}</span>
          ) : null}
        </div>
      </div>

      {/* selection settings (admin.setup.manage) */}
      {showSettings ? (
        <SelectionSettings
          weeklyCap={props.weeklyCap}
          restrictToSafe={props.restrictToSafe}
          onClose={() => setShowSettings(false)}
          onSaved={() => { setShowSettings(false); router.refresh() }}
        />
      ) : null}

      {/* recommended bills */}
      <div className="max-h-[22rem] min-h-0 flex-1 overflow-y-auto">
        {payable.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{t('empty')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {payable.map((e) => {
                const on = selected.has(e.id)
                return (
                  <tr
                    key={e.id}
                    className="group cursor-pointer border-b border-slate-50 last:border-0 hover:bg-slate-50/60 dark:border-slate-800/60 dark:hover:bg-slate-800/30"
                    onClick={() => toggle(e.id)}
                  >
                    <td className="w-9 py-2 pl-4">
                      <input type="checkbox" readOnly checked={on} className="h-4 w-4 accent-teal-600" aria-label={e.partyName} />
                    </td>
                    <td className="py-2">
                      <span className="font-medium text-slate-700 dark:text-slate-200">{e.partyName}</span>
                      {e.daysOverdue > 0 ? <Badge variant="warning" className="ml-1.5 text-[10px]">{e.daysOverdue}d</Badge> : null}
                    </td>
                    <td className="py-2 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">{e.dueDate ? fmtDate(e.dueDate) : '—'}</td>
                    <td className="py-2 pr-4 text-right font-medium tabular-nums text-slate-800 dark:text-slate-200">{money(e.amount)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* action bar */}
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
        <span className="text-xs text-slate-500 dark:text-slate-400">{t('selected', { count: selectedEntries.length })}</span>
        <Button size="sm" disabled={selectedEntries.length === 0} onClick={build}>
          {t('build')}
          <ArrowRight size={15} />
        </Button>
      </div>
    </div>
  )
}

/**
 * Inline editor for the AP-to-pay selection rule. Persists to the shared
 * cashflow config (orgs.settings.analytics.cashflow) via the same endpoint the
 * analytics Configuration tab uses, so the forecast and planner stay in sync.
 */
function SelectionSettings({
  weeklyCap,
  restrictToSafe,
  onClose,
  onSaved,
}: {
  weeklyCap: number
  restrictToSafe: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const t = useTranslations('ap.cockpit.payRun.settings')
  const [cap, setCap] = useState(String(weeklyCap))
  const [safe, setSafe] = useState(restrictToSafe)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setErr(null)
    const r = await fetch('/api/analytics/config/cashflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weeklyApCap: Number(cap) || 0, restrictToSafe: safe ? 1 : 0 }),
    })
    setBusy(false)
    if (r.ok) onSaved()
    else setErr(r.status === 403 ? t('needPermission') : t('saveFailed'))
  }

  return (
    <div className="space-y-3 border-b border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/20">
      <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">{t('title')}</p>
      <label className="block">
        <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">{t('weeklyCapLabel')}</span>
        <input
          type="number"
          min={0}
          step={1000}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
        />
        <span className="mt-0.5 block text-[11px] leading-snug text-slate-400 dark:text-slate-500">{t('weeklyCapHelp')}</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} className="mt-0.5 h-4 w-4 accent-teal-600" />
        <span>
          <span className="text-[11px] font-medium text-slate-600 dark:text-slate-300">{t('safeLabel')}</span>
          <span className="block text-[11px] leading-snug text-slate-400 dark:text-slate-500">{t('safeHelp')}</span>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={save}>{busy ? t('saving') : t('save')}</Button>
        <button type="button" onClick={onClose} className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{t('cancel')}</button>
        {err ? <span className="text-xs text-red-500">{err}</span> : null}
      </div>
    </div>
  )
}
