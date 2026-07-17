'use client'

import { useMemo, useState } from 'react'
import { cn } from '@openbooks/ui'

/**
 * Tiny sortable-table helper shared by analytics tables. `useSort` keeps the
 * active column + direction and returns the sorted rows plus a `SortTh` header
 * cell that toggles direction on click (numeric or string compare, nulls last).
 */
export function useSort<T>(rows: T[], initial: { key: keyof T; dir: 'asc' | 'desc' }) {
  const [key, setKey] = useState<keyof T>(initial.key)
  const [dir, setDir] = useState<'asc' | 'desc'>(initial.dir)

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => {
      const av = a[key]
      const bv = b[key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      const cmp = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv)
      return dir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [rows, key, dir])

  const onSort = (col: keyof T, defaultDir: 'asc' | 'desc' = 'desc') => {
    if (col === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setKey(col); setDir(defaultDir) }
  }

  function SortTh({ label, col, align = 'right', defaultDir, className }: { label: string; col: keyof T; align?: 'left' | 'right' | 'center'; defaultDir?: 'asc' | 'desc'; className?: string }) {
    const active = col === key
    return (
      <th className={cn('px-4 py-2 font-medium', align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left', className)}>
        <button type="button" onClick={() => onSort(col, defaultDir)} className={cn('inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300', active && 'text-teal-600 dark:text-teal-400')}>
          {label}
          {active ? <span className="text-[9px]">{dir === 'asc' ? '▲' : '▼'}</span> : null}
        </button>
      </th>
    )
  }

  return { sorted, SortTh, key, dir }
}
