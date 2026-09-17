import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

// F-t05-001: /banking/cash?horizon=26 intermittently served a raw
// "Internal Server Error" text page — no shell, no retry, back-nav to
// recover. A throw in (app)/layout.tsx (a dozen concurrent queries behind a
// ten-connection pool over a slow link) cannot be caught by
// (app)/error.tsx: Next.js never routes a segment's own layout failure to
// that segment's boundary, and the root segment had no error.tsx (only
// global-error.tsx, which covers root-layout failures). The root error.tsx
// is the fail-closed surface for those above-the-app-shell failures.

const errorPath = new URL('./error.tsx', import.meta.url)

function errorSource(): string {
  assert.equal(
    existsSync(errorPath),
    true,
    'web/app/error.tsx must exist so failures above the (app) shell fail closed in-app instead of a raw 500',
  )
  return readFileSync(errorPath, 'utf8')
}

test('root route error boundary exists and is a client component', () => {
  const source = errorSource()
  assert.match(source, /['"]use client['"]/, 'error boundaries must be client components')
})

test('root boundary accepts the error/reset contract and recovers in-app', () => {
  const source = errorSource()
  assert.match(source, /export default function \w+/, 'boundary must default-export a component')
  assert.match(source, /reset/, 'boundary must offer a retry via reset()')
  assert.match(source, /RouteStateView/, 'boundary must reuse the house route-state chrome')
  assert.match(source, /state="error"/, 'boundary must carry the machine-readable error signal')
  assert.match(source, /\/dashboard/, 'boundary must offer a way back without browser back-nav')
})

test('root boundary stays client-safe (no server-only imports)', () => {
  const source = errorSource()
  assert.doesNotMatch(source, /server-only/, 'a client boundary importing server-only would crash while handling the crash')
})
