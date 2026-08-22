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

test('app file upserts pin the known tenant on the version_id/path conflict write', () => {
  assert.match(
    store,
    /insert into app_files[\s\S]*?on conflict \(version_id, path\) do update set[\s\S]*?where app_files\.org_id = \$\{orgId\}/,
  )
})

test('app listing upserts pin the known publisher on the key conflict write', () => {
  assert.match(
    store,
    /insert into app_listings[\s\S]*?on conflict \(key\) do update set[\s\S]*?where app_listings\.publisher_org_id = \$\{orgId\}/,
  )
})
