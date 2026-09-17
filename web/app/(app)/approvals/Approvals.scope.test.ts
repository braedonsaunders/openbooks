import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = source('./view.ts')
const api = source('../../api/flows/gates/route.ts')
const dashboard = source('../dashboard/_metrics.ts')
const application = source('../../../lib/application/approvals.ts')

test('approval worklists enforce subsidiary visibility in every consumer', () => {
  // The center mine/all tabs and the dashboard tile + widgets all read the
  // unified worklist (F-t01-007) — never a gates-only subquery — so
  // same-labeled figures tie by construction.
  assert.match(page, /approvalWorklistForAuthz\(authz\)/)
  assert.match(dashboard, /approvalWorklistForAuthz\(authz\)/)
  assert.doesNotMatch(page, /worklistGates\(/)
  assert.doesNotMatch(dashboard, /worklistGates\(/)
  assert.match(api, /worklistGates\(\s*authz\.user\.orgId,\s*authz\.user\.id,\s*undefined,\s*authz\.allowedSubsidiaryIds/)
  assert.match(application, /context\.authz\.allowedSubsidiaryIds/)

  const pageFilters = page.match(/subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/g) ?? []
  assert.equal(pageFilters.length, 1, 'submitted approval query must be scoped')
  // The dashboard lists read the unified worklist, which scopes every kind
  // (Flows gates, document approvals, pay runs) by the caller's authz.
  assert.match(application, /export async function approvalWorklistForAuthz\(authz: Authz\)/)
})
