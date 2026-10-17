'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { readApiErrorMessage } from '@/lib/api-error'

export const CELL = 'px-4 py-2.5'
export const HEAD = 'px-4 py-2 font-medium'
export const NUM_HEAD = `${HEAD} text-right`
export const NUM_CELL = `${CELL} text-right tabular-nums`
export const LINK = 'font-medium text-teal-700 hover:underline dark:text-teal-300'

export const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline' | 'destructive'> = {
  outstanding: 'success',
  exercised: 'secondary',
  settled: 'secondary',
  converted: 'secondary',
  transferred: 'secondary',
  forfeited: 'warning',
  expired: 'warning',
  cancelled: 'warning',
  repurchased: 'outline',
  void: 'destructive',
  not_issued: 'outline',
}

/** Whole-share counts are bigint strings; they are formatted without crossing a float. */
export function useShares(): (value: string | null | undefined) => string {
  const locale = useLocale()
  return (value) => {
    if (value === null || value === undefined || !/^-?\d+$/.test(value)) return '—'
    return new Intl.NumberFormat(locale).format(BigInt(value))
  }
}

/** A stored ten-place price, trimmed of trailing zeros beyond two places for reading. */
export function priceText(value: string | null | undefined): string {
  if (!value) return '—'
  const [whole, fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return `${whole}.${trimmed.padEnd(2, '0')}`
}

export const percentText = (value: string | null | undefined): string => (value ? `${value}%` : '—')

export function searchText(row: object): string {
  return Object.values(row).filter((value) => typeof value === 'string' || typeof value === 'number').join(' ')
}

/** POST JSON and return the parsed body; a refusal throws its message and remedy. */
export async function postJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(await readApiErrorMessage(res, fallback))
  return (await res.json()) as T
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  )
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/** Peer sub-views of one tab: links that replace the body, one active at a time. */
export function PillTabs({ tabs, label }: { tabs: { href: string; label: string; active: boolean }[]; label: string }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label={label}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.active ? 'page' : undefined}
          className={tab.active
            ? 'rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900'
            : 'rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  )
}

/** Local peer sub-views (no URL): buttons that replace the body. */
export function SegmentTabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (value: T) => void; tabs: { key: T; label: string }[]; label: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={value === tab.key
            ? 'rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900'
            : 'rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function withParams(base: string, params: Record<string, string | string[] | undefined>, overrides: Record<string, string | undefined>): string {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (typeof value === 'string' && value !== '') next.set(key, value)
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === '') next.delete(key)
    else next.set(key, value)
  }
  const query = next.toString()
  return query ? `${base}?${query}` : base
}
