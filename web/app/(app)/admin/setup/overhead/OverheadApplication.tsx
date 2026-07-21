'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Label, Select, cn } from '@openbooks/ui'
import { PagedTable } from '../../../../../components/paged-table'

export interface ApplicationRow {
  id: string
  entry_number: string
  posting_date: string
  status: string
  applied_total: string
  projects: number
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
  unapplied: { entries: number; hours: string }
}) {
  const t = useTranslations('admin.setup.entities.overhead-model.application')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState(props.mode)
  const [accountId, setAccountId] = useState(props.accountId ?? '')

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

  async function backfill() {
    setBusy(true)
    try {
      const r = await post({ action: 'backfill-overhead' })
      toast.success(t('backfilled', { total: Number(r.total).toFixed(2), entries: r.entries }))
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
            <Select id="ovh-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">—</option>
              {props.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </Select>
          </div>
        )}
        <Button size="sm" onClick={saveMode} disabled={busy}>{t('save')}</Button>
      </div>

      {mode === 'net_zero_pair' && (
        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('autoHint')}</p>
          {props.unapplied.entries > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md bg-amber-50 p-2.5 dark:bg-amber-950/30">
              <span className="text-xs text-amber-700 dark:text-amber-300">
                {t('backfillPrompt', { entries: props.unapplied.entries, hours: Number(props.unapplied.hours).toFixed(0) })}
              </span>
              <Button size="sm" variant="outline" onClick={backfill} disabled={busy || !props.accountId}>
                {t('backfill')}
              </Button>
            </div>
          )}
          {props.applications.length > 0 && (
            <div className="mt-3">
              <PagedTable
                rows={props.applications}
                rowKey={(a) => a.id}
                pageSize={8}
                empty={null}
                columns={[
                  { key: 'entry', header: t('entry'), cell: (a) => <span className="font-mono text-xs">{a.entry_number}</span> },
                  { key: 'date', header: t('date'), cell: (a) => <span className="tabular-nums">{a.posting_date}</span> },
                  { key: 'projects', header: t('projects'), cell: (a) => <span className="tabular-nums">{a.projects}</span> },
                  { key: 'total', header: t('total'), cell: (a) => <span className="tabular-nums">${Number(a.applied_total).toFixed(2)}</span> },
                  { key: 'status', header: t('status'), cell: (a) => a.status },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </section>
  )
}
