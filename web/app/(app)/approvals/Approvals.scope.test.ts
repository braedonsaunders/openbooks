import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = source('./view.ts')
const api = source('../../api/flows/gates/route.ts')
const dashboard = source('../dashboard/_metrics.ts')
const application = source('../../../lib/application/approvals.ts')

test('approval worklists enforce subsidiary visibility in every consumer', () => {
  assert.match(page, /worklistGates\(orgId, user\.id, undefined, authz\.allowedSubsidiaryIds\)/)
  assert.match(api, /worklistGates\(\s*authz\.user\.orgId,\s*authz\.user\.id,\s*undefined,\s*authz\.allowedSubsidiaryIds/)
  assert.match(dashboard, /worklistGates\(orgId, userId, undefined, authz\.allowedSubsidiaryIds\)/)
  assert.match(application, /context\.authz\.allowedSubsidiaryIds/)

  const pageFilters = page.match(/subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/g) ?? []
  assert.equal(pageFilters.length, 2, 'all and submitted approval queries must be scoped')
  const dashboardFilters = dashboard.match(/subsidiaryVisibleFilter\(sql`d\.subsidiary_id`, authz\.allowedSubsidiaryIds\)/g) ?? []
  assert.equal(dashboardFilters.length, 2, 'dashboard approval count and list must be scoped')
})
