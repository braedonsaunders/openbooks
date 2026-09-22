'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { mergeHref } from '../../../lib/list-params'

/**
 * Unsaved-create: opens a URL-controlled unsaved drawer (`?paymentNew=1`).
 * Zero writes on open — the payment is persisted only by the drawer's
 * explicit Save (one idempotent POST to /api/payments). The kind stays fixed
 * by the entry surface (the section's `kind` prop), and no sequence or
 * document number is allocated until that Save commits.
 */
export function NewPaymentButton({
  basePath,
  label,
}: {
  // Kind stays in the contract (the section fixes it per surface) but the
  // button itself no longer needs it: opening writes nothing, and the drawer
  // derives the kind from its own `side`.
  kind: 'vendor_payment' | 'customer_payment'
  basePath: string
  label: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const current = Object.fromEntries(searchParams.entries())

  function open() {
    router.push(mergeHref(basePath, current, {
      payment: undefined,
      paymentNew: '1',
      mode: 'edit',
    }) as never)
  }

  return (
    <Button onClick={open}>
      <Plus size={15} /> {label}
    </Button>
  )
}
