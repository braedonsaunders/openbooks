import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { stubModules } from '../../../../../testing/stub-modules'

stubModules({
  navigation: true, intl: true, features: true, authz: true,
  extra: {
    'server-only': 'export {}',
    '@openbooks/engine/src/platform/db.ts': 'export const db = { execute(query) { return globalThis.__setupParentExecute(query) } }; export function ambientTenantOrgId() { return null }; export function withBypassContext(fn) { return fn() }; export function currentRequestOrgResolver() { return null }; export function registerRequestOrgResolver() {}',
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { SetupEntitySection } = await import('./SetupEntitySection.tsx')
const { SetupDrawer } = await import('./SetupDrawer.tsx')
const { SETUP_ENTITY_BY_KEY } = await import('../../../../../lib/setup/registry.ts')
const dialect = new PgDialect()

function elements(node: unknown): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!React.isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children)]
}

test('nested setup lists, edit selection and new values stay bound to the owning record', async () => {
  const orgId = '11111111-1111-4111-8111-111111111111'
  const ownerId = '22222222-2222-4222-8222-222222222222'
  const otherOwnerId = '33333333-3333-4333-8333-333333333333'
  const childId = '44444444-4444-4444-8444-444444444444'
  const foreignId = '55555555-5555-4555-8555-555555555555'
  const otherOrgChildId = '66666666-6666-4666-8666-666666666666'
  for (const [key, parentKey, field, ownerValue] of [
    ['tax-registrations', 'tax-jurisdictions', 'jurisdiction_id', ownerId],
    ['tax-pool-classes', 'tax-regimes', 'regime', 'CA-CCA'],
    ['entitlement-service-tiers', 'entitlement-plans', 'plan_id', ownerId],
    ['entitlement-service-tiers', 'pay-components', 'component_id', ownerId],
  ]) {
    const entity = SETUP_ENTITY_BY_KEY.get(key!)!
    const owned = { id: childId, org_id: orgId, [field!]: ownerValue }
    const other = { id: foreignId, org_id: orgId, [field!]: field === 'regime' ? 'US-MACRS' : otherOwnerId }
    const otherOrg = { id: otherOrgChildId, org_id: otherOwnerId, [field!]: ownerValue }
    const queries: { sql: string; params: unknown[] }[] = []
    Object.assign(globalThis, { __setupParentExecute: (query: SQL) => {
      const statement = dialect.sqlToQuery(query)
      if (!statement.sql.includes(`from ${entity.table}`)) return Promise.resolve({ rows: [] })
      queries.push(statement)
      const bound = (column: string) => {
        const match = statement.sql.match(new RegExp(`\\b${column} = \\$(\\d+)`))
        return match ? statement.params[Number(match[1]) - 1] : undefined
      }
      const rows = [owned, other, otherOrg].filter((row) =>
        ['org_id', field!, 'id'].every((column) => bound(column) === undefined || row[column as keyof typeof row] === bound(column)),
      )
      return Promise.resolve({ rows: /count\(\*\)/.test(statement.sql) ? [{ n: rows.length }] : rows })
    } })
    const props = {
      entity, orgId, basePath: '/admin/setup/owner', canManage: true,
      parent: { recordKey: parentKey!, value: ownerValue! },
      rowParam: 'childRow', paramPrefix: 'child', stacked: true,
    }
    const result = await SetupEntitySection({ ...props, searchParams: { row: ownerId, childRow: foreignId, q: 'parent search' } })
    const nodes = elements(result)
    assert.equal(nodes.filter((node) => node.type === SetupDrawer).length, 0, `${key}: another owner's id must not open an edit or create drawer`)
    const links = nodes.map((node) => node.props.href).filter((href): href is string => typeof href === 'string')
    assert.ok(links.some((href) => href.includes(`childRow=${childId}`)), `${key}: owning record must remain reachable`)
    assert.ok(!links.some((href) => href.includes(`childRow=${foreignId}`) || href.includes(`childRow=${otherOrgChildId}`)), `${key}: list must exclude other owners and organizations`)
    assert.ok(queries.every((query) => !query.params.includes('%parent search%')), 'child search must not inherit the outer list search')

    const created = await SetupEntitySection({ ...props, searchParams: { row: ownerId, childRow: 'new' } })
    const drawer = elements(created).find((node) => node.type === SetupDrawer)!
    assert.ok(drawer, `${key}: New must open a nested drawer`)
    const fixed = drawer.props.fixedValues as Record<string, unknown>
    for (const binding of entity.parentRecords ?? []) {
      assert.equal(fixed[binding.fieldKey], binding.entityKey === parentKey ? ownerValue : null, `${key}: mutually exclusive owners must stay fixed`)
    }
    assert.equal(drawer.props.stacked, true)
    assert.match(String(drawer.props.closeHref), new RegExp(`row=${ownerId}`))
    await assert.rejects(() => SetupEntitySection({ ...props, parent: undefined, searchParams: {} }), /A parent record is required/)
  }
})
