'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

/**
 * Statutory holiday pay (calculateStub phase 2), rendered WITH the holiday
 * elections it governs. Changes gross pay, so it is an explicit org decision;
 * jurisdictions with no declared formula refuse by name when a holiday falls
 * in the period. Saves through the same /api/payroll/settings PUT as every
 * other payroll setting (the API merges keys).
 */
export function StatHolidayPaySection(props: { statutoryHolidayPay: boolean }) {
  const t = useTranslations('payroll.settingsPage')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(props.statutoryHolidayPay)

  async function save(next: boolean) {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statutoryHolidayPay: next }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'failed')
      setEnabled(next)
      toast.success(t('saved'))
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('statHolidayPay.title')}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('statHolidayPay.description')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void save(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600"
        />
        {t('statHolidayPay.enabled')}
      </label>
    </section>
  )
}
