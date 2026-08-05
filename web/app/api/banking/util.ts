import { NextResponse } from 'next/server'
import { BankingError } from '@openbooks/engine/src/banking.ts'

/** Map engine BankingError → 422 with its user-safe message; anything else → 500. */
export function bankingErrorResponse(e: unknown): NextResponse {
  if (e instanceof BankingError) {
    return NextResponse.json({ error: e.message }, { status: e.status })
  }
  console.error('[banking]', e)
  return NextResponse.json({ error: 'Internal error' }, { status: 500 })
}
