import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/customization/list-preferences/route.ts', import.meta.url), 'utf8')

test('list-preference upserts pin the known tenant on the org_id/user_id/record_type conflict write', () => {
  assert.match(
    route,
    /insert into user_list_preferences[\s\S]*?on conflict \(org_id, user_id, record_type\) do update[\s\S]*?where user_list_preferences\.org_id = \$\{user\.orgId\}/,
  )
})
