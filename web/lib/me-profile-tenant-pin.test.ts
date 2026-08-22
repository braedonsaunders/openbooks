import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/me/route.ts', import.meta.url), 'utf8')

test('self-service profile writes pin the known tenant on the users id update', () => {
  assert.match(
    route,
    /update users set[\s\S]*?where id = \$\{user\.id\} and org_id = \$\{user\.orgId\}/,
  )
})
