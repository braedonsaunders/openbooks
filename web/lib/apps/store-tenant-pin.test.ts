import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')

test('app storage upserts pin the known tenant on the app_id/namespace/key conflict write', () => {
  assert.match(
    store,
    /insert into app_storage[\s\S]*?on conflict \(app_id, namespace, key\) do update set[\s\S]*?where app_storage\.org_id = \$\{orgId\}/,
  )
})
