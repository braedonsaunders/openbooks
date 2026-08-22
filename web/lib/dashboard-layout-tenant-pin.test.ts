import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../app/(app)/dashboard/actions.ts', import.meta.url), 'utf8')

test('customize-layout upserts pin the known tenant on the org_id/user_id conflict write', () => {
  assert.match(
    source,
    /if \(existingLayout\?\.quickActions\) layout\.quickActions = existingLayout\.quickActions[\s\S]*?insert into user_dashboard_layouts[\s\S]*?on conflict \(org_id, user_id\)[\s\S]*?do update set[\s\S]*?where user_dashboard_layouts\.org_id = \$\{authz\.user\.orgId\}/,
  )
})
