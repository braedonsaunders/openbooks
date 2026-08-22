import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/parties/[id]/route.ts', import.meta.url), 'utf8')

test('customer-role upserts pin the known tenant on the party_id conflict write', () => {
  assert.match(
    route,
    /insert into customer_roles[\s\S]*?on conflict \(party_id\) do update set[\s\S]*?where customer_roles\.org_id = \$\{user\.orgId\}/,
  )
})

test('vendor-role upserts pin the known tenant on the party_id conflict write', () => {
  assert.match(
    route,
    /insert into vendor_roles[\s\S]*?on conflict \(party_id\) do update set[\s\S]*?where vendor_roles\.org_id = \$\{user\.orgId\}/,
  )
})

test('employee-role upserts pin the known tenant on the party_id conflict write', () => {
  assert.match(
    route,
    /insert into employee_roles[\s\S]*?on conflict \(party_id\) do update set[\s\S]*?where employee_roles\.org_id = \$\{user\.orgId\}/,
  )
})
