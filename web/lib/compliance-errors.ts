import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'

/**
 * Shared failure mapper for compliance write verbs. It lives apart from
 * `@/lib/compliance` on purpose: route tests mock the gates there (authn,
 * subsidiary scope, feature flag), and keeping the mapper unmocked means the
 * regression tests exercise the real mapping instead of a permissive double.
 *
 * Known Postgres constraint violations become named refusals the operator can
 * act on; everything else becomes a generic 500 carrying a correlation id.
 * Driver text — table names, constraint names, parameter values — stays in
 * the server log, never in the body.
 */
export function complianceWriteFailure(error: unknown): NextResponse {
  const code = (error as { code?: unknown } | null)?.code
  if (code === '23505') {
    return NextResponse.json(
      { error: 'conflicts with an existing record — reread it before writing again' },
      { status: 409 },
    )
  }
  if (code === '23503') {
    return NextResponse.json(
      { error: 'a referenced record no longer exists — reread the form and retry' },
      { status: 422 },
    )
  }
  if (code === '22P02' || code === '22001') {
    return NextResponse.json(
      { error: 'an input value has an invalid shape for its column' },
      { status: 400 },
    )
  }
  const correlationId = randomUUID()
  console.error(
    `[compliance-write-failure] ${correlationId}:`,
    error instanceof Error ? error.message : error,
  )
  return NextResponse.json({ error: 'save failed', correlationId }, { status: 500 })
}
