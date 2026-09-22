'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/**
 * Order creation entry point, two modes:
 *
 * - Unsaved-create (`createParam` set: estimates/sales-orders/purchase-orders
 *   pass `estimateNew`/`orderNew`): opens a URL-controlled unsaved drawer
 *   (`?<createParam>=1`) with zero writes — the order is persisted only by
 *   the drawer's explicit Save (one idempotent collection POST).
 * - Legacy instant-into-draft (`createParam` absent: field tickets still use
 *   this widget with its own `apiPath` until its own slice migrates it):
 *   creates the draft server-side, opens its flyout.
 *
 * @deprecated The `apiPath` legacy branch exists ONLY for the field-tickets
 * caller. The Field Tickets unsaved-create slice owns its removal: give
 * field tickets their own button/route contract, then delete `apiPath`,
 * `createFailedMessage`, `createDraft`, and the final `fetch` below so this
 * component becomes URL-only.
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
  const searchParams = useSearchParams()

  // URL-only create: no fetch, so no busy state and no failure message.
  function openUnsaved() {
    const current = Object.fromEntries(searchParams.entries())
    router.push(mergeHref(base, current, { [param]: undefined, [createParam!]: '1' }) as never)
  }

  // DEPRECATED (see header): the last fetch in this file. The Field Tickets
  // slice deletes this branch with the `apiPath` prop when it migrates.
  async function createDraft() {
    setBusy(true)
    // finally releases busy on every path; the catch turns a transport
    // throw into the same operator-visible refusal as a server refusal.
    try {
      const res = await fetch(`${apiPath}/draft`, { method: 'POST' })
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
    return (
      <Button onClick={openUnsaved}>
        <Plus size={15} /> {label}
      </Button>
    )
  }

  return (
    <Button onClick={createDraft} disabled={busy}>
      <Plus size={15} /> {busy ? tCommon('actions.creating') : label}
    </Button>
  )
}
