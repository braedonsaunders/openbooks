'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Popover } from '@openbooks/ui'

export interface NewDocumentItem {
  kind: string
  label: string
}

/**
 * "New <transaction>" dropdown: lists the creatable kinds for a module. Each
 * item mints an instant draft server-side (POST /api/documents/draft) and
 * opens it in the flyout at `?doc=<id>` over the module's list page.
 */
export function NewDocumentButton({
  items,
  basePath,
  triggerLabel,
  creatingLabel,
  failedLabel,
  paramKey = 'doc',
}: {
  items: NewDocumentItem[]
  basePath: string
  triggerLabel: string
  creatingLabel: string
  failedLabel: string
  paramKey?: string
}) {
  const [open, setOpen] = useState(false)
  const [busyKind, setBusyKind] = useState<string | null>(null)
  const router = useRouter()

  // Single kind → plain button (no dropdown).
  if (items.length === 1) {
    const only = items[0]!
    async function create() {
      setBusyKind(only.kind)
      const res = await fetch('/api/documents/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: only.kind }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? failedLabel)
        setBusyKind(null)
        return
      }
      router.push(`${basePath}?${paramKey}=${data.id}`)
      router.refresh()
      setBusyKind(null)
    }
    return (
      <Button onClick={create} disabled={busyKind !== null}>
        <Plus size={15} /> {busyKind !== null ? creatingLabel : only.label}
      </Button>
    )
  }

  async function create(kind: string) {
    setOpen(false)
    setBusyKind(kind)
    const res = await fetch('/api/documents/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? failedLabel)
      setBusyKind(null)
      return
    }
    router.push(`${basePath}?${paramKey}=${data.id}`)
    router.refresh()
    setBusyKind(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <Button onClick={() => setOpen((v) => !v)} disabled={busyKind !== null}>
          <Plus size={15} /> {busyKind !== null ? creatingLabel : triggerLabel}
          <ChevronDown size={14} className="opacity-60" />
        </Button>
      }
    >
      <div className="p-1">
        {items.map((item) => (
          <button
            key={item.kind}
            type="button"
            disabled={busyKind !== null}
            onClick={() => create(item.kind)}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  )
}
