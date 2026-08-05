'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Building2 } from 'lucide-react'

/**
 * Subsidiary context switcher for subsidiary-aware operational pages
 * (Banking, Cash). URL-param driven (`?sub=<id>`, absent = whole company) so
 * views are shareable and survive tab navigation. Callers hide it for
 * single-subsidiary orgs by passing an empty/1-item picker — same gate the
 * reports filter bar uses. Options come from `reportSubsidiaryView().picker`
 * (already role-filtered, depth-indented, "(consolidated)"-labelled).
 */
export function SubsidiarySwitcher({
  picker,
  value,
  label,
  paramKey = 'sub',
}: {
  picker: { id: string; label: string }[]
  /** Currently selected subsidiary id ('' = whole company / root default). */
  value: string
  /** Accessible label, e.g. t('subsidiary'). */
  label: string
  paramKey?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const onChange = useCallback(
    (id: string) => {
      const next = new URLSearchParams(searchParams?.toString())
      if (id) next.set(paramKey, id)
      else next.delete(paramKey)
      const qs = next.toString()
      router.push(`${pathname}${qs ? `?${qs}` : ''}` as never)
    },
    [router, pathname, searchParams, paramKey],
  )

  if (picker.length < 2) return null
  return (
    <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
      <Building2 size={14} className="shrink-0 text-slate-400" aria-hidden />
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="max-w-[14rem] cursor-pointer truncate bg-transparent font-medium outline-none"
      >
        {picker.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  )
}
