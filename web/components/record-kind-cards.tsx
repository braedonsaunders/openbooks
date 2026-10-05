'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { cn } from '@openbooks/ui'

export interface RecordKindCardOption<V extends string = string> {
  value: V
  label: string
  description: string
  icon: ReactNode
  selected?: boolean
  metadata?: ReactNode
}

/** The shared large selection card, also used for live module previews. */
export function RecordKindCard({ label, description, icon, metadata, selected, href, onChoose, children, compact = false, prefetch }: {
  label: string
  description: string
  icon: ReactNode
  metadata?: ReactNode
  selected?: boolean
  href?: string
  onChoose?: () => void
  children?: ReactNode
  compact?: boolean
  prefetch?: boolean
}) {
  const className = cn('group flex h-full w-full flex-col items-start justify-start rounded-xl border border-slate-200 bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600', compact ? 'p-3.5' : 'p-5', selected && 'border-teal-400 bg-teal-50/30 dark:border-teal-600')
  const body = <>
    <span className={cn('flex w-full items-center justify-between gap-3', compact ? 'mb-2' : 'mb-4')}>
      <span className={cn('grid shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700 transition-colors group-hover:bg-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:group-hover:bg-teal-900/70', compact ? 'h-8 w-8' : 'h-11 w-11')}>{icon}</span>
      {metadata}
    </span>
    <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{label}</span>
    <span className={cn('block text-slate-500 dark:text-slate-400', compact ? 'mt-1 line-clamp-1 text-xs leading-4' : 'mt-1.5 text-sm leading-5')}>{description}</span>
    {children}
  </>
  return href
    ? <Link href={href} prefetch={prefetch} className={className}>{body}</Link>
    : <button type="button" onClick={onChoose} aria-pressed={selected} className={className}>{body}</button>
}

/**
 * The first step of creating a record whose kind decides everything after
 * it: one large card per kind, each naming what that kind is for. Choosing a
 * card hands the kind back to the drawer, which then shows only the fields
 * that kind needs. Shared by every create drawer that opens on a kind choice
 * so they look and behave the same.
 */
export function RecordKindCards<V extends string>({
  options,
  onChoose,
  heading,
  description,
  gridClassName,
}: {
  options: RecordKindCardOption<V>[]
  onChoose: (value: V) => void
  /** Optional step heading after a first choice (kind, then structure). */
  heading?: string
  description?: string
  gridClassName?: string
}) {
  return (
    <div className="space-y-3">
      {heading || description ? (
        <div>
          {heading ? <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{heading}</h3> : null}
          {description ? <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p> : null}
        </div>
      ) : null}
      <div className={cn('grid gap-4 md:grid-cols-2 xl:grid-cols-3', gridClassName)}>
      {options.map((option) => (
        <RecordKindCard
          key={option.value}
          onChoose={() => onChoose(option.value)}
          {...option}
        />
      ))}
      </div>
    </div>
  )
}
