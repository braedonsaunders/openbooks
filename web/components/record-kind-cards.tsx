'use client'

import type { ReactNode } from 'react'

export interface RecordKindCardOption<V extends string = string> {
  value: V
  label: string
  description: string
  icon: ReactNode
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
}: {
  options: RecordKindCardOption<V>[]
  onChoose: (value: V) => void
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChoose(option.value)}
          className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600"
        >
          <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-teal-50 text-teal-700 transition-colors group-hover:bg-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:group-hover:bg-teal-900/70">
            {option.icon}
          </span>
          <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{option.label}</span>
          <span className="mt-1.5 block text-sm leading-5 text-slate-500 dark:text-slate-400">{option.description}</span>
        </button>
      ))}
    </div>
  )
}
