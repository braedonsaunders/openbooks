import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/me/page-layout/route.ts', import.meta.url), 'utf8')

test('page-layout upserts pin the known tenant on the org_id/user_id/page conflict write', () => {
  assert.match(
    route,
    /insert into user_page_layouts[\s\S]*?on conflict \(org_id, user_id, page\)[\s\S]*?do update set[\s\S]*?where user_page_layouts\.org_id = \$\{user\.orgId\}/,
  )
})
