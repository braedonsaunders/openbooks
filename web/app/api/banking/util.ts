import { NextResponse } from 'next/server'
import { BankingError } from '@openbooks/engine/src/banking/banking.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'

/** Map engine BankingError → 422 with its user-safe message; anything else → 500. */
export function bankingErrorResponse(e: unknown): NextResponse {
  if (e instanceof BankingError) {
    return NextResponse.json({ error: e.message }, { status: e.status })
  }
  // Canonical subsidiary-scope denial: a record outside the caller's
  // boundary reads exactly like a missing one — uniform 404, never a 500.
  if (e instanceof ScopeNotFoundError) {
    return NextResponse.json({ error: e.message }, { status: e.status })
  }
  console.error('[banking]', e)
  return NextResponse.json({ error: 'Internal error' }, { status: 500 })
}
