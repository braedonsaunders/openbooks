import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PaymentDrawer.tsx', import.meta.url), 'utf8')

test('draft payment saves carry the exact document revision token required by the PATCH API', () => {
  assert.match(
    source,
    /expectedUpdatedAt:\s*doc\.updated_at/,
    'the drawer must echo the loaded updated_at revision on every draft save',
  )
})

test('final payment posting carries the revision token fenced by post-with-applications', () => {
  assert.match(
    source,
    /fetch\('\/api\/payments\/post-with-applications'[\s\S]*?expectedUpdatedAt:\s*doc\.updated_at/,
    'the Pay & post action must send the loaded revision so a stale drawer 409s instead of overwriting the allocation set',
  )
})
