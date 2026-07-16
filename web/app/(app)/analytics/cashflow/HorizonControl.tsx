'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Select } from '@openbooks/ui'

/** Horizon selector (4 / 8 / 12 weeks) — drives the ?horizon query param. */
export function HorizonControl({ value }: { value: number }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function set(weeks: string) {
    const next = new URLSearchParams(params.toString())
    next.set('horizon', weeks)
    router.replace(`${pathname}?${next.toString()}`)
  }

  return (
    <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/60 px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900/40">
      <span className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">Horizon</span>
      <Select value={String(value)} onChange={(e) => set(e.target.value)} triggerClassName="h-7 w-auto text-sm font-medium" aria-label="Forecast horizon">
        <option value="4">4 Weeks</option>
        <option value="8">8 Weeks</option>
        <option value="12">12 Weeks</option>
      </Select>
    </label>
  )
}
