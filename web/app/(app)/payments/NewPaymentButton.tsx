'use client'

import { UnsavedCreateButton } from '@/components/unsaved-create-button'

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
  return (
    <UnsavedCreateButton
      base={basePath}
      param="paymentNew"
      clear={['payment']}
      label={label}
      extra={{ mode: 'edit' }}
    />
  )
}
