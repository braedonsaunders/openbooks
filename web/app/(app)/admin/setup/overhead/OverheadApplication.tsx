'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Input, Label, cn } from '@openbooks/ui'

export interface ApplicationRow {
  id: string
  entry_number: string
  posting_date: string
  status: string
  applied_total: string
  projects: number
}

const selectCls =
  'h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'

function monthWindow(offset: number): { start: string; end: string } {
  const now = new Date()
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset, 1))
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  const iso = (x: Date) => x.toISOString().slice(0, 10)
  return { start: iso(d), end: iso(end) }
}

/**
 * How overhead reaches the ledger. report_only keeps it purely statistical;
 * net_zero_pair posts DR overhead account [project] / CR the SAME account
 * untagged — project ledger views carry burden, the account and P&L net to
 * zero (the account balance doubles as the audit: it must stay ~0).
 */
export function OverheadApplication(props: {
  mode: 'report_only' | 'net_zero_pair' | 'off'
  accountId: string | null
  accounts: { id: string; label: string }[]
  applications: ApplicationRow[]
}) {
  const t = useTranslations('admin.setup.entities.overhead-model.application')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(props.mode)
  const [accountId, setAccountId] = useState(props.accountId ?? '')
  const [period, setPeriod] = useState(monthWindow(-1))

  async function post(payload: Record<string, unknown>) {
    const res = await fetch('/api/admin/setup/overhead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error ?? 'failed')
    return j
  }

  async function saveMode() {
    setBusy(true)
    try {
      await post({ action: 'set-application', mode, accountId: accountId || null })
      toast.success(t('saved'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function applyPeriod() {
    setBusy(true)
    try {
      const r = await post({ action: 'apply-period', periodStart: period.start, periodEnd: period.end })
      toast.success(t('applied', { total: Number(r.total).toFixed(2), projects: r.projects }))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('hint')}</p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex gap-2">
          {(['report_only', 'net_zero_pair', 'off'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm',
                mode === m
                  ? 'border-teal-600 bg-teal-50 font-medium text-teal-700 dark:border-teal-400 dark:bg-teal-950/50 dark:text-teal-300'
                  : 'border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800',
              )}
            >
              {t(`modes.${m}`)}
            </button>
          ))}
        </div>
        {mode === 'net_zero_pair' && (
          <div className="min-w-64">
            <Label htmlFor="ovh-acct">{t('account')}</Label>
            <select id="ovh-acct" className={cn(selectCls)} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {props.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>
        )}
        <Button size="sm" onClick={saveMode} disabled={busy}>{t('save')}</Button>
      </div>

      {mode === 'net_zero_pair' && (
        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="ovh-from">{t('periodStart')}</Label>
              <Input id="ovh-from" type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ovh-to">{t('periodEnd')}</Label>
              <Input id="ovh-to" type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} />
            </div>
            <Button size="sm" variant="outline" onClick={applyPeriod} disabled={busy || !props.accountId}>
              {t('apply')}
            </Button>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('applyHint')}</p>
          </div>
          {props.applications.length > 0 && (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-1 pr-2 font-medium">{t('entry')}</th>
                  <th className="py-1 pr-2 font-medium">{t('date')}</th>
                  <th className="py-1 pr-2 font-medium">{t('projects')}</th>
                  <th className="py-1 pr-2 text-right font-medium">{t('total')}</th>
                  <th className="py-1 pr-2 font-medium">{t('status')}</th>
                </tr>
              </thead>
              <tbody>
                {props.applications.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-2 font-mono text-xs">{a.entry_number}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{a.posting_date}</td>
                    <td className="py-1.5 pr-2 tabular-nums">{a.projects}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">${Number(a.applied_total).toFixed(2)}</td>
                    <td className="py-1.5 pr-2">{a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}
