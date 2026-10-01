import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import type { FormSection } from '@openbooks/forms-core'
import { CELL_PROVENANCE_KEY } from './types.ts'

interface RecordImportState {
  searchData: Record<string, unknown> | null
}

const stateKey = Symbol.for('openbooks.record-import-test')
const importState: RecordImportState = { searchData: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) {
        return { strings, values }
      }
    `,
  ],
  [
    'mock:db',
    `
      export const schema = {}
      export const db = {
        async execute() {
          throw new Error('database execution is not expected during this dry-run test')
        },
      }
    `,
  ],
  [
    'mock:records',
    `
      const state = globalThis[Symbol.for('openbooks.record-import-test')]

      export async function loadRecordTypeByKey() {
        return { id: 'record-type-1', status: 'published' }
      }

      export async function buildSearchText(_orgId, _sections, data) {
        state.searchData = structuredClone(data)
        return 'record search text'
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      // The pure cap/gate re-export the REAL ./export-cap.ts through this
      // double — never copied. Only impure surfaces are stubbed below.
      export * from '${new URL('./export-cap.ts', import.meta.url).href}'

      export class RefResolver {
        async resolveId() {
          throw new Error('reference resolution is not expected in this test')
        }
      }

      export async function exportCell(_field, value) {
        return value
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mockUrl = new Map([
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
      ['../records', 'mock:records'],
      ['./resource-core', 'mock:resource-core'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const resourceUrl = './record-resources.ts?xlsx-field-aware-import-test'
const { recordResource } = await import(resourceUrl) as typeof import('./record-resources.ts')
const parseUrl = './parse.ts?record-xlsx-field-aware-import-test'
const { parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

const sections: FormSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    fields: [
      { id: 'external_id', label: 'External ID', type: 'text', required: true },
      {
        id: 'category',
        label: 'Category',
        type: 'select',
        required: true,
        validation: { options: [{ value: '101', label: 'Category 101' }] },
      },
      {
        id: 'priority',
        label: 'Priority',
        type: 'radio',
        required: true,
        validation: { options: [{ value: '202', label: 'Priority 202' }] },
      },
      { id: 'quantity', label: 'Quantity', type: 'number', required: true },
      { id: 'amount', label: 'Amount', type: 'currency', required: true },
    ],
  },
]

async function parsedWorkbookRow(): Promise<Record<string, unknown>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Custom records')
  sheet.addRow(['external_id', 'category', 'priority', 'quantity', 'amount'])
  sheet.addRow([
    123456,
    101,
    { formula: '101+101', result: 202 },
    7.5,
    // Currency arrives as exact decimal text, never a float.
    '42.25',
  ])
  const buffer = await workbook.xlsx.writeBuffer()
  const parsed = await parseImportFile('xlsx', {
    base64: Buffer.from(buffer as ArrayBuffer).toString('base64'),
  })
  const row = parsed.rows[0]
  assert.ok(row)
  return row
}

test('custom-record XLSX import coerces schema-owned text and choice fields to display strings', async () => {
  importState.searchData = null
  const row = await parsedWorkbookRow()
  assert.equal(typeof row.external_id, 'number')
  assert.equal(typeof row.category, 'number')
  assert.equal(typeof row.priority, 'number')
  assert.equal(typeof row.quantity, 'number')
  assert.equal(typeof row.amount, 'string')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], { priority: 'formula' })

  const outcome = await recordResource('org-1', 'inventory-tag', sections, 'Inventory tag').write(
    [row],
    'insert',
    { orgId: 'org-1', actorId: 'actor-1', dryRun: true },
  )

  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  const searchData = importState.searchData as Record<string, unknown> | null
  assert.ok(searchData)
  assert.deepEqual(searchData, {
    external_id: '123456',
    category: '101',
    priority: '202',
    quantity: 7.5,
    amount: '42.25',
  })
  assert.equal(typeof searchData.external_id, 'string')
  assert.equal(typeof searchData.category, 'string')
  assert.equal(typeof searchData.priority, 'string')
  assert.equal(typeof searchData.quantity, 'number')
  assert.equal(typeof searchData.amount, 'string')
})

// --- Setup-gated resource catalog (web/lib/data-io/resources.ts) --------------
// These cases import the real registry lazily: the module-hook doubles above
// are deregistered before the first test runs, so `await import` here resolves
// the production modules against the scratch database, not the mocks.

async function catalogModules() {
  const { getResource, listResources } = await import('./resources.ts')
  const { SETUP_ENTITY_BY_KEY, SETUP_ENTITIES } = await import('../setup/registry.ts')
  const { resolvedFeatureState } = await import('../features.ts')
  const { sql } = await import('drizzle-orm')
  const { db } = await import('@openbooks/engine/src/platform/db.ts')
  const { createScratchOrg, dropScratchOrgReporting } = await import('@openbooks/engine/src/testing/fixtures.ts')
  return { getResource, listResources, SETUP_ENTITY_BY_KEY, SETUP_ENTITIES, resolvedFeatureState, sql, db, createScratchOrg, dropScratchOrgReporting }
}

/** Pin the org's feature flags, then read the state back so a zero-row write
 *  fails loudly here instead of silently testing the defaults. */
async function setCatalogFeatures(modules: Awaited<ReturnType<typeof catalogModules>>, orgId: string, flags: Record<string, boolean>): Promise<void> {
  await modules.db.execute(modules.sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb, true) where id = ${orgId}`)
  const state = await modules.resolvedFeatureState(orgId)
  for (const [key, value] of Object.entries(flags)) {
    assert.equal(state[key], value, `feature flag ${key} did not persist`)
  }
}

/** A test-local any-of descriptor. Its table does not exist, so resolving a
 *  resource for it must never touch storage — the catalog only describes. */
function registerCatalogProbe(modules: Awaited<ReturnType<typeof catalogModules>>, key: string, featureKeysAny: string[]): void {
  modules.SETUP_ENTITY_BY_KEY.set(key, {
    key,
    table: 'c7a_consumer_probe_missing_table',
    groupKey: 'projects',
    iconKey: 'briefcase',
    orgScoped: true,
    hasActive: false,
    featureKeysAny,
    columns: [],
    fields: [],
  })
  modules.SETUP_ENTITIES.push(modules.SETUP_ENTITY_BY_KEY.get(key)!)
}

test('setup resource catalog honors an any-of descriptor through the shared gate', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const modules = await catalogModules()
  const org = await modules.createScratchOrg()
  const probeKey = 'c7a-catalog-any-of-probe'
  registerCatalogProbe(modules, probeKey, ['projects', 'manufacturing'])
  try {
    await setCatalogFeatures(modules, org.orgId, { projects: false, manufacturing: false })
    const closed = await modules.listResources(org.orgId)
    assert.ok(!closed.some((descriptor) => descriptor.key === probeKey), 'a both-off any-of entity is hidden from the catalog')
    assert.equal(await modules.getResource(org.orgId, probeKey), null)
    // Either member on admits through the same helper — describing the
    // resource needs no storage behind the gate.
    await setCatalogFeatures(modules, org.orgId, { projects: false, inventory: true, manufacturing: true })
    const admitted = await modules.listResources(org.orgId)
    assert.ok(admitted.some((descriptor) => descriptor.key === probeKey), 'one member on lists the entity')
    assert.ok(await modules.getResource(org.orgId, probeKey), 'one member on resolves the resource')
  } finally {
    modules.SETUP_ENTITY_BY_KEY.delete(probeKey)
    modules.SETUP_ENTITIES.splice(modules.SETUP_ENTITIES.findIndex((entity) => entity.key === probeKey), 1)
    await modules.dropScratchOrgReporting(org.orgId)
  }
})

test('setup resource catalog fails closed on unknown keys', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const modules = await catalogModules()
  const org = await modules.createScratchOrg()
  const probeKey = 'c7a-catalog-unknown-probe'
  registerCatalogProbe(modules, probeKey, ['no-such-feature'])
  try {
    await setCatalogFeatures(modules, org.orgId, { projects: true, manufacturing: true, inventory: true })
    const listed = await modules.listResources(org.orgId)
    assert.ok(!listed.some((descriptor) => descriptor.key === probeKey), 'an unknown member never admits')
    assert.equal(await modules.getResource(org.orgId, probeKey), null)
  } finally {
    modules.SETUP_ENTITY_BY_KEY.delete(probeKey)
    modules.SETUP_ENTITIES.splice(modules.SETUP_ENTITIES.findIndex((entity) => entity.key === probeKey), 1)
    await modules.dropScratchOrgReporting(org.orgId)
  }
})

test('setup resource catalog keeps single-key behavior', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const modules = await catalogModules()
  const org = await modules.createScratchOrg()
  try {
    await setCatalogFeatures(modules, org.orgId, { projects: false })
    const closed = await modules.listResources(org.orgId)
    assert.ok(!closed.some((descriptor) => descriptor.key === 'overhead-rates'))
    assert.equal(await modules.getResource(org.orgId, 'overhead-rates'), null)
    await setCatalogFeatures(modules, org.orgId, { projects: true })
    const admitted = await modules.listResources(org.orgId)
    assert.ok(admitted.some((descriptor) => descriptor.key === 'overhead-rates'))
    assert.ok(await modules.getResource(org.orgId, 'overhead-rates'))
  } finally {
    await modules.dropScratchOrgReporting(org.orgId)
  }
})
