'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { UnsavedCreateButton } from '@/components/unsaved-create-button'

/**
 * Order creation entry point, two modes:
 *
 * - Unsaved-create (`createParam` set: estimates/sales-orders/purchase-orders
 *   pass `estimateNew`/`orderNew`): opens a URL-controlled unsaved drawer
 *   (`?<createParam>=1`) with zero writes — the order is persisted only by
 *   the drawer's explicit Save (one idempotent collection POST).
 * - Instant draft (`createParam` absent: field tickets use this widget with
 *   their collection `apiPath`): creates the draft server-side, opens its flyout.
 *
 * The `apiPath` branch is used only by field tickets, whose editor requires a
 * persisted record before the operator can choose its project and period.
 *
 * `base`/`param` build the list route deep-link (e.g. /estimates);
 * `label` and `createFailedMessage` arrive pre-translated from the owning
 * list page.
 */
export function NewOrderButton({
  apiPath,
  base,
  param,
  createParam,
  label,
  createFailedMessage,
}: {
  apiPath?: string
  base: string
  param: string
  createParam?: string
  label: string
  createFailedMessage?: string
}) {
  const tCommon = useTranslations('common')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function createDraft() {
    setBusy(true)
    // finally releases busy on every path; the catch turns a transport
    // throw into the same operator-visible refusal as a server refusal.
    try {
      const res = await fetch(apiPath!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        toast.error((data as { error?: string } | null)?.error ?? createFailedMessage)
        return
      }
      const data = await res.json()
      router.push(`${base}?${param}=${data.id}&mode=edit`)
      router.refresh()
    } catch {
      toast.error(createFailedMessage ?? tCommon('feedback.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (createParam) {
    return <UnsavedCreateButton base={base} param={createParam} clear={[param]} label={label} />
  }

  return (
    <Button onClick={createDraft} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : label}
    </Button>
  )
}
