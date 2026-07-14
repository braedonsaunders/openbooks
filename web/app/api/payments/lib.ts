import 'server-only'
import { NextResponse } from 'next/server'
import { PaymentError, type PaymentKind } from '@openbooks/engine/src/payments.ts'
import { PostingError } from '@openbooks/engine/src/posting.ts'

/** ap.pay for vendor payments, ar.pay for customer receipts. */
export function paymentPermission(kind: PaymentKind): 'ap.pay' | 'ar.pay' {
  return kind === 'vendor_payment' ? 'ap.pay' : 'ar.pay'
}

export function isPaymentKind(kind: unknown): kind is PaymentKind {
  return kind === 'vendor_payment' || kind === 'customer_payment'
}

/** Uniform error mapping: domain errors are 422, everything else 500. */
export function paymentErrorResponse(e: unknown): NextResponse {
  const status = e instanceof PaymentError || e instanceof PostingError ? 422 : 500
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status })
}
