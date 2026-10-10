'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Plus } from 'lucide-react'
import { Button, Popover } from '@openbooks/ui'
import { documentCreateHref } from '../lib/document-kinds'

export interface NewDocumentItem {
  kind: string
  label: string
  /** A related record created on its own surface (for example Receive
   *  payment on the receivables cockpit): the item navigates here instead
   *  of opening the document drawer for `kind`. */
  href?: string
}

/**
 * "New <transaction>" dropdown: URL-only navigation to `?doc=new&kind=`,
 * which renders the tenant-customizable DocumentDrawer in createMode over
 * an in-memory payload. Opening New allocates nothing — no document, no
 * number, no lines, no audit row; the first write happens on explicit Save
 * (POST /api/documents), and Cancel/close writes nothing.
 */
export function NewDocumentButton({
  items,
  basePath,
  triggerLabel,
}: {
  items: NewDocumentItem[]
  basePath: string
  triggerLabel: string
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  function create(item: NewDocumentItem) {
    setOpen(false)
    router.push(item.href ?? documentCreateHref(basePath, item.kind))
  }

  // No creatable kind → no control: never a dropdown that opens empty.
  if (items.length === 0) return null

  // Single kind → plain button (no dropdown).
  if (items.length === 1) {
    const only = items[0]!
    return (
      <Button onClick={() => create(only)}>
        <Plus size={15} /> {only.label}
      </Button>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <Button onClick={() => setOpen((v) => !v)}>
          <Plus size={15} /> {triggerLabel}
          <ChevronDown size={14} className="opacity-60" />
        </Button>
      }
    >
      <div className="p-1">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => create(item)}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  )
}
