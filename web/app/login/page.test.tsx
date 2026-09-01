import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { safeNextPath } from './page.tsx'

const pageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('safeNextPath preserves same-origin relative destinations', () => {
  assert.equal(safeNextPath('/reports?view=profit-and-loss#totals'), '/reports?view=profit-and-loss#totals')
  assert.equal(safeNextPath('/'), '/')
})

test('safeNextPath fails closed for unsafe, malformed, empty, and oversized values', () => {
  for (const value of [
    'https://evil.example/phishing',
    '//evil.example/phishing',
    '/\\evil.example/phishing',
    '/\\[malformed',
    'not a URL',
    '',
    null,
    'x'.repeat(2049),
  ]) {
    assert.equal(safeNextPath(value), '/', `expected fallback for ${JSON.stringify(value)}`)
  }
})

test('password/MFA navigation and OIDC start links share the validated destination', () => {
  assert.match(pageSource, /const nextPath = safeNextPath\(params\.get\('next'\)\)/)
  assert.match(pageSource, /router\.push\(nextPath\)/)
  assert.match(pageSource, /encodeURIComponent\(nextPath\)/)
})
