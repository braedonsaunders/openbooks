'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@openbooks/ui'

export interface QueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean
  durationMs: number
}

function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return true
  if (typeof v !== 'string') return false
  return v.trim() !== '' && /^-?\d[\d,]*(\.\d+)?$/.test(v.trim())
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

type SortDir = 'asc' | 'desc' | null

/**
 * The results surface of the SQL console: a virtualization-free but
 * hard-working grid — client-side per-column sort, an in-result quick filter,
 * a fixed header, zebra rows, right-aligned monospace numerics, and explicit
 * null rendering. Purely presentational; the console owns the data.
 */
export function ResultsGrid({ result, filter }: { result: QueryResult; filter: string }) {
  const t = useTranslations('query')
  const [sortCol, setSortCol] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)

  // Which columns read as numeric (sampled from the first rows) → right-align
  // + numeric-aware sort.
  const numericCols = useMemo(() => {
    const set = new Set<string>()
    for (const col of result.columns) {
      const sample = result.rows.slice(0, 25).map((r) => r[col]).filter((v) => v !== null && v !== undefined)
      if (sample.length > 0 && sample.every(isNumeric)) set.add(col)
    }
    return set
  }, [result])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return result.rows
    return result.rows.filter((r) => result.columns.some((c) => cellText(r[c]).toLowerCase().includes(q)))
  }, [result, filter])

  const sorted = useMemo(() => {
    if (!sortCol || !sortDir) return filtered
    const num = numericCols.has(sortCol)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = a[sortCol]
      const bv = b[sortCol]
      if (av === null || av === undefined) return 1
      if (bv === null || bv === undefined) return -1
      if (num) return (Number(String(av).replace(/,/g, '')) - Number(String(bv).replace(/,/g, ''))) * dir
      return cellText(av).localeCompare(cellText(bv), undefined, { numeric: true }) * dir
    })
  }, [filtered, sortCol, sortDir, numericCols])

  function toggleSort(col: string) {
    if (sortCol !== col) {
      setSortCol(col)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortCol(null)
      setSortDir(null)
    }
  }

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-sm text-slate-500 dark:text-slate-400">
        {t('emptyResultSet')}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-slate-50 dark:bg-slate-900">
            <th className="w-12 border-b border-slate-200 px-2 py-2 text-right font-medium text-slate-400 tabular-nums dark:border-slate-800 dark:text-slate-500">
              #
            </th>
            {result.columns.map((c) => {
              const active = sortCol === c
              return (
                <th
                  key={c}
                  onClick={() => toggleSort(c)}
                  className={cn(
                    'group cursor-pointer select-none border-b border-slate-200 px-3 py-2 font-semibold whitespace-nowrap dark:border-slate-800',
                    numericCols.has(c) ? 'text-right' : 'text-left',
                    active ? 'text-teal-700 dark:text-teal-300' : 'text-slate-600 dark:text-slate-300',
                  )}
                >
                  <span className={cn('inline-flex items-center gap-1.5', numericCols.has(c) && 'flex-row-reverse')}>
                    <span className="font-mono">{c}</span>
                    {active ? (
                      sortDir === 'asc' ? (
                        <ArrowUp size={13} className="shrink-0" />
                      ) : (
                        <ArrowDown size={13} className="shrink-0" />
                      )
                    ) : (
                      <ChevronsUpDown size={13} className="shrink-0 text-slate-300 opacity-0 group-hover:opacity-100 dark:text-slate-600" />
                    )}
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={i}
              className="border-b border-slate-100 last:border-0 odd:bg-white even:bg-slate-50/40 hover:bg-teal-50/50 dark:border-slate-800/60 dark:odd:bg-slate-950 dark:even:bg-slate-900/30 dark:hover:bg-teal-950/20"
            >
              <td className="px-2 py-1.5 text-right align-top font-mono text-[11px] text-slate-300 tabular-nums dark:text-slate-600">
                {i + 1}
              </td>
              {result.columns.map((c) => {
                const v = row[c]
                const isNull = v === null || v === undefined
                return (
                  <td
                    key={c}
                    className={cn(
                      'max-w-[28rem] truncate px-3 py-1.5 align-top',
                      numericCols.has(c) ? 'text-right font-mono tabular-nums text-slate-800 dark:text-slate-200' : 'text-slate-700 dark:text-slate-300',
                    )}
                    title={isNull ? 'NULL' : cellText(v)}
                  >
                    {isNull ? <span className="text-slate-300 dark:text-slate-600">∅</span> : cellText(v)}
                  </td>
                )
              })}
            </tr>
          ))}
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={result.columns.length + 1} className="px-3 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                {t('noFilterMatch')}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

/** Serialize a result to CSV (RFC-4180-ish quoting). Shared by copy + download. */
export function resultToCsv(result: QueryResult): string {
  const esc = (v: unknown) => {
    const s = cellText(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = result.columns.map(esc).join(',')
  const body = result.rows.map((r) => result.columns.map((c) => esc(r[c])).join(',')).join('\n')
  return `${header}\n${body}`
}
