import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// UX-20: an empty provision table must not invite a Compute the reader
// cannot open. Preparers see the compute invitation; restricted callers
// read the organization-wide grant instead.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('the provision empty state is permission-aware (UX-20)', () => {
  assert.match(
    source,
    /emptyText: canCompute \? t\('empty'\) : t\('emptyNoGrant'\)/,
    'the loader must pick the empty copy by the compute grant',
  )
  const catalog = readFileSync(new URL('../../../../messages/en/tax.json', import.meta.url), 'utf8')
  assert.match(catalog, /"emptyNoGrant": "No provision runs yet\. Only preparers/)
})
