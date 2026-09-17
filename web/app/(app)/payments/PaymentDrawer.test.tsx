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

test('payment voids carry the revision token required by the void API', () => {
  assert.match(
    source,
    /\/void`,\s*\{[\s\S]*?JSON\.stringify\(\{\s*reason,\s*expectedUpdatedAt/,
    'the void action must echo the loaded revision: /api/documents/[id]/void answers 409 without it, so a token-less void can never succeed',
  )
})

test('a refused Receive & post surfaces the typed message and pins it past the toast', () => {
  assert.match(
    source,
    /async function post\(\)[\s\S]*?readDocumentActionResult\(res\)/,
    'the post action must read through the shared action-result reader: a non-JSON 422 body makes a bare res.json() throw past the toast and wedges the button busy (F-t02-006)',
  )
  assert.match(
    source,
    /async function post\(\)[\s\S]*?setActionError\(message\)[\s\S]*?toast\.error\(message\)/,
    'a refused post must toast the typed message AND pin it as a record-level alert',
  )
  assert.match(
    source,
    /\{actionError \? \(\s*<p role="alert"/,
    'the pinned refusal must render as a persistent alert at the top of the drawer body',
  )
})

test('a failed post never wedges the Receive & post button busy', () => {
  assert.match(
    source,
    /async function post\(\)[\s\S]*?finally\s*\{[\s\S]*?setBusy\(false\)/,
    'the post action must release busy in a finally: a rejected transport must not wedge the button on',
  )
})
