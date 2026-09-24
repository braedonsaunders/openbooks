'use client'

import type { ReactNode } from 'react'

/** A keyboard-operable, text-named action for drilling into a table record. */
export function TableDrilldownButton({
  children,
  onActivate,
}: {
  children: ReactNode
  onActivate: () => void
}) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="text-left hover:text-teal-700 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600 dark:hover:text-teal-300"
    >
      {children}
    </button>
  )
}
