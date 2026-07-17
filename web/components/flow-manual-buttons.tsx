'use client'

// Manual flow-trigger buttons for a record flyout — the author-defined
// "record buttons" (manual trigger nodes on an enabled flow graph). Fetches
// the caller-visible buttons from /api/flows/manual (requirePermission +
// showIf are enforced server-side) and renders one outline button each,
// with the authored confirm text routed through the shared confirmDialog.
// Renders nothing while loading or when no flow offers a button, so the
// drawer header is untouched for orgs without flows.

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'
import { confirmDialog } from '../lib/confirm'
import { refreshApprovalState } from './approval-actions'

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
  const [busyButtonId, setBusyButtonId] = useState<string | null>(null)

  const loadButtons = useCallback(async () => {
    const res = await fetch(
      `/api/flows/manual?subjectKind=${encodeURIComponent(subjectKind)}&subjectId=${encodeURIComponent(subjectId)}`,
    )
    const data = res.ok ? await res.json() : { buttons: [] }
    return Array.isArray(data.buttons) ? data.buttons as ManualButton[] : []
  }, [subjectKind, subjectId])

  useEffect(() => {
    let cancelled = false
    loadButtons()
      .then((next) => {
        if (!cancelled) setButtons(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [loadButtons])

  if (buttons.length === 0) return null

  async function run(button: ManualButton) {
    if (button.confirm && !(await confirmDialog({ message: button.confirm }))) return
    setBusyButtonId(button.buttonId)
    try {
      const res = await fetch('/api/flows/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectKind, subjectId, buttonId: button.buttonId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) {
        toast.error(data.error ?? tc('feedback.somethingWentWrong'))
        return
      }
      toast.success(tc('feedback.flowActionDone'))
      setButtons(await loadButtons().catch(() => []))
      refreshApprovalState()
      router.refresh()
    } catch {
      toast.error(tc('feedback.somethingWentWrong'))
    } finally {
      setBusyButtonId(null)
    }
  }

  return (
    <>
      {buttons.map((b) => (
        <Button key={b.buttonId} variant="outline" disabled={busyButtonId !== null} onClick={() => run(b)}>
          {b.label}
        </Button>
      ))}
    </>
  )
}
