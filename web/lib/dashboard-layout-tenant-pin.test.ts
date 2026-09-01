import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../app/(app)/dashboard/actions.ts', import.meta.url), 'utf8')

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `missing ${name} implementation`)
  const end = source.indexOf(`export async function ${nextName}`, start)
  assert.notEqual(end, -1, `missing ${nextName} implementation`)
  return source.slice(start, end)
}

function assertTenantPinned(body: string): void {
  assert.match(
    body,
    /on conflict \(org_id, user_id\)[\s\S]*?do update set[\s\S]*?where user_dashboard_layouts\.org_id = \$\{authz\.user\.orgId\}/,
  )
}

test('customize-layout upserts pin the known tenant on the org_id/user_id conflict write', () => {
  const body = functionBody('saveDashboardLayout', 'resetDashboardLayout')

  // The layout save is a read-merge-write: quick actions belong to the
  // sibling saveQuickActions action and must survive a concurrent layout save.
  assert.match(body, /layout\.quickActions\s*=\s*(?:normalizeQuickActions\()?existingLayout\.quickActions/)
  assertTenantPinned(body)
})

test('quick-actions upserts pin the known tenant on the org_id/user_id conflict write', () => {
  const body = functionBody('saveQuickActions', 'listQuickActionOptions')

  // Quick-action saves must retain the layout grid while replacing only the
  // caller's quick actions (and any hidden actions preserved by policy).
  assert.match(body, /widgets:\s*existingLayout\.widgets\s*\?\?\s*\[\]/)
  assert.match(body, /existingLayout\.quickActions\s*\?\?\s*\[\]/)
  assertTenantPinned(body)
})
