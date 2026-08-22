import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/continuous-close/items/[id]/feedback/route.ts', import.meta.url), 'utf8')

test('work-item feedback upserts pin the known tenant on the work_item_id/user_id conflict write', () => {
  assert.match(
    route,
    /insert into ai_work_item_feedback[\s\S]*?on conflict \(work_item_id, user_id\) do update set[\s\S]*?where ai_work_item_feedback\.org_id = \$\{authz\.user\.orgId\}/,
  )
})
