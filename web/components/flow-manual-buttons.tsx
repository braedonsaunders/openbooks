'use client'

// Manual flow-trigger buttons for a record flyout — the author-defined
// "record buttons" (manual trigger nodes on an enabled flow graph). Fetches
// the caller-visible buttons from /api/flows/manual (requirePermission +
// showIf are enforced server-side) and renders one outline button each,
// with the authored confirm text routed through the shared confirmDialog.
// Renders nothing while loading or when no flow offers a button, so the
// drawer header is untouched for orgs without flows.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { confirmDialog } from '../lib/confirm'

interface ManualButton {
  buttonId: string
  label: string
  confirm?: string
}

export function FlowManualButtons({
  subjectKind,
  subjectId,
}: {
  subjectKind: string
  subjectId: string
}) {
  const tc = useTranslations('common')
  const router = useRouter()
  const [buttons, setButtons] = useState<ManualButton[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(
      `/api/flows/manual?subjectKind=${encodeURIComponent(subjectKind)}&subjectId=${encodeURIComponent(subjectId)}`,
    )
      .then((res) => (res.ok ? res.json() : { buttons: [] }))
      .then((data) => {
        if (!cancelled) setButtons(Array.isArray(data.buttons) ? data.buttons : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [subjectKind, subjectId])

  if (buttons.length === 0) return null

  async function run(button: ManualButton) {
    if (button.confirm && !(await confirmDialog({ message: button.confirm }))) return
    setBusy(true)
    const res = await fetch('/api/flows/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectKind, subjectId, buttonId: button.buttonId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      toast.error(data.error ?? tc('feedback.somethingWentWrong'))
    } else {
      toast.success(tc('feedback.flowActionDone'))
    }
    setBusy(false)
    router.refresh()
  }

  return (
    <>
      {buttons.map((b) => (
        <Button key={b.buttonId} variant="outline" disabled={busy} onClick={() => run(b)}>
          {b.label}
        </Button>
      ))}
    </>
  )
}
