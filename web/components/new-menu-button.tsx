'use client'

import { useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { Button, Popover } from '@openbooks/ui'

export interface NewMenuItem {
  key: string
  label: string
}

/** Shared house "New" dropdown chrome. Domain components own what an item
 * does; this component owns the button and menu so module headers never
 * approximate the AR control with local markup. */
export function NewMenuButton({
  label,
  busyLabel,
  items,
  busy = false,
  onSelect,
}: {
  label: string
  busyLabel: string
  items: NewMenuItem[]
  busy?: boolean
  onSelect: (key: string) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) return null
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <Button onClick={() => setOpen((value) => !value)} disabled={busy}>
          <Plus size={15} /> {busy ? busyLabel : label}
          <ChevronDown size={14} className="opacity-60" />
        </Button>
      }
    >
      <div className="min-w-48 p-1" role="menu">
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false)
              void onSelect(item.key)
            }}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  )
}
