import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { ListViewConfig } from '@openbooks/customization'

/**
 * The source registry is server-only and imports the live database module.
 * Replace those server seams so this contract test exercises the real source
 * WHERE builders and aggregate definition without requiring a running app.
 */
function testSubsidiaryVisibleFilter(column: SQL, allowed: ReadonlySet<string> | null): SQL {
  if (!allowed) return sql``
  const ids = [...allowed]
  return ids.length
    ? sql` and ${column} = any(${`{${ids.join(',')}}`}::uuid[])`
    : sql` and false`
}

;(globalThis as typeof globalThis & { inventorySubsidiaryFilter?: typeof testSubsidiaryVisibleFilter })
  .inventorySubsidiaryFilter = testSubsidiaryVisibleFilter

const subsidiaryModule = 'export const subsidiaryVisibleFilter = globalThis.inventorySubsidiaryFilter'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db={execute:async()=>({rows:[]})}',
      }
    }
    if (specifier === '../subsidiaries') {
      return {
        shortCircuit: true,
        format: 'module',
        url: `data:text/javascript,${encodeURIComponent(subsidiaryModule)}`,
      }
    }
    return nextResolve(specifier, context)
  },
})

const { entityListSource } = (await import('../list/entity-sources.ts')) as typeof import('../list/entity-sources.ts')
hooks.deregister()

const dialect = new PgDialect()
const ORG_ID = '00000000-0000-4000-8000-000000000001'
const SUBSIDIARY_A = '00000000-0000-4000-8000-00000000000a'
const SUBSIDIARY_B = '00000000-0000-4000-8000-00000000000b'

const onhandView = {
  schemaVersion: 1,
  recordType: 'inventory_onhand',
  columns: [],
  filters: [],
} as ListViewConfig

const movementView = {
  schemaVersion: 1,
  recordType: 'inventory_movement',
  columns: [],
  filters: [],
} as ListViewConfig

const adhoc = { filters: {}, showInactive: false }

function compileWhere(recordType: 'inventory_onhand' | 'inventory_movement', allowed: Set<string> | null) {
  const source = entityListSource(recordType)
  assert.ok(source)
  const view = recordType === 'inventory_onhand' ? onhandView : movementView
  return dialect.sqlToQuery(source.where(view, adhoc, ORG_ID, allowed))
}

test('restricted on-hand and movement lists bind the caller subsidiary scope', () => {
  const onhand = compileWhere('inventory_onhand', new Set([SUBSIDIARY_A]))
  const movement = compileWhere('inventory_movement', new Set([SUBSIDIARY_A, SUBSIDIARY_B]))

  assert.match(onhand.sql, /oh\.org_id = \$1/)
  assert.match(onhand.sql, /oh\.subsidiary_id = any\(\$2::uuid\[\]\)/)
  assert.deepEqual(onhand.params, [ORG_ID, `{${SUBSIDIARY_A}}`])
  assert.match(movement.sql, /m\.org_id = \$1/)
  assert.match(movement.sql, /m\.subsidiary_id = any\(\$2::uuid\[\]\)/)
  assert.deepEqual(movement.params, [ORG_ID, `{${SUBSIDIARY_A},${SUBSIDIARY_B}}`])
})

test('an empty subsidiary scope fails closed for both inventory lists', () => {
  const onhand = compileWhere('inventory_onhand', new Set())
  const movement = compileWhere('inventory_movement', new Set())

  assert.match(onhand.sql, /and false/)
  assert.match(movement.sql, /and false/)
  assert.deepEqual(onhand.params, [ORG_ID])
  assert.deepEqual(movement.params, [ORG_ID])
})

test('an unrestricted inventory caller retains tenant-only predicates', () => {
  const onhand = compileWhere('inventory_onhand', null)
  const movement = compileWhere('inventory_movement', null)

  assert.doesNotMatch(onhand.sql, /subsidiary_id/)
  assert.doesNotMatch(movement.sql, /subsidiary_id/)
  assert.deepEqual(onhand.params, [ORG_ID])
  assert.deepEqual(movement.params, [ORG_ID])
})

test('on-hand positions are grouped and keyed per subsidiary before list filtering', () => {
  const source = entityListSource('inventory_onhand')
  assert.ok(source)
  assert.equal(typeof source.table, 'string')
  assert.match(source.table as string, /select org_id, subsidiary_id, item_id, stock_location_id/)
  assert.match(source.table as string, /group by org_id, subsidiary_id, item_id, stock_location_id/)

  const id = dialect.sqlToQuery(source.idExpr!)
  assert.match(id.sql, /oh\.subsidiary_id::text/)
})
