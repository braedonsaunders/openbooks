// Run with:  node --import tsx --test web/lib/modules/manifest.test.ts   (from repo root)
//
// Unit tests for the module manifest zod schema: contribution kinds with
// per-kind payload schemas, parseModuleManifest (never throws), projection
// statuses (page projects; everything else reports NOT_IMPLEMENTED_YET).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { page } from '@braedonsaunders/appkit-viewspec'
import {
  CONTRIBUTION_KINDS,
  PROJECTION_TARGETS,
  PROJECTED_KINDS,
  moduleManifestSchema,
  parseModuleManifest,
  projectionStatuses,
  projectionSummary,
  type ModuleContribution,
  type ModuleManifest,
} from './manifest.ts'

/** A valid PageSpec, built with the host's own builder. */
function validSpec(route: string) {
  return page({ route, header: [], body: [] })
}

/** A minimal valid manifest, extended per test. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'revenue-recast',
    name: 'Revenue Recast',
    version: '1.0.0',
    permissions: ['gl.read'],
    contributions: [],
    ...overrides,
  }
}

// --- module identity ----------------------------------------------------------

test('moduleManifestSchema accepts a valid manifest and applies defaults', () => {
  const r = parseModuleManifest(base())
  assert.equal(r.ok, true)
  assert.deepEqual(r.manifest!.permissions, ['gl.read'])
  assert.deepEqual(r.manifest!.contributions, [])
})

test('parseModuleManifest rejects a bad slug key', () => {
  const r = parseModuleManifest(base({ key: 'Bad Key!' }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /key must be a slug/)
})

test('parseModuleManifest rejects a bad version', () => {
  const r = parseModuleManifest(base({ version: 'v-one' }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /version/)
})

test('parseModuleManifest rejects unknown contribution kinds', () => {
  const r = parseModuleManifest(base({ contributions: [{ kind: 'warp-drive' }] }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /kind/)
})

test('parseModuleManifest never throws on garbage input', () => {
  for (const garbage of [null, 42, 'text', [], [{}], { key: 5 }, Symbol.iterator]) {
    const r = parseModuleManifest(garbage)
    assert.equal(r.ok, false, `expected rejection for ${String(garbage)}`)
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0)
    assert.equal(r.manifest, undefined)
  }
})

// --- contribution catalogue ---------------------------------------------------

test('CONTRIBUTION_KINDS covers all thirteen kinds', () => {
  assert.deepEqual([...CONTRIBUTION_KINDS], [
    'page', 'panel', 'record-type', 'field', 'report', 'card', 'job',
    'endpoint', 'hook', 'flow', 'agent', 'permission', 'setting',
  ])
})

test('every contribution kind has a projection target', () => {
  for (const kind of CONTRIBUTION_KINDS) {
    assert.ok(PROJECTION_TARGETS[kind], `missing target for ${kind}`)
  }
})

test('PROJECTED_KINDS is exactly page in v1', () => {
  assert.deepEqual([...PROJECTED_KINDS], ['page'])
})

// --- page kind: the v1 projection contract ------------------------------------

test('page contribution requires route+spec and defaults scope to org', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'page', route: '/reports/recast', spec: validSpec('/reports/recast') }],
  }))
  assert.equal(r.ok, true, r.errors.join('; '))
  const c = r.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'page' }>
  assert.equal(c.scope, 'org')
  assert.equal(c.route, '/reports/recast')
})

test('page contribution rejects a spec that does not validate', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'page', route: '/reports/recast', spec: { specVersion: 99, route: '/x', layout: 'bogus', header: [], body: [] } }],
  }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /spec\./)
})

test('page contribution rejects a non-absolute route', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'page', route: 'reports/recast', spec: validSpec('reports/recast') }],
  }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /route must be an absolute route pattern/)
})

test('page contribution rejects a spec whose declared route differs from its filing route', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'page', route: '/reports/recast', spec: validSpec('/somewhere/else') }],
  }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /declaring route \/somewhere\/else/)
})

test('page contribution rejects scope user (a module customizes the org, never one person)', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'page', route: '/x', spec: validSpec('/x'), scope: 'user' }],
  }))
  assert.equal(r.ok, false)
})

test('page contribution accepts dynamic segment route patterns', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'page', route: '/revenue/[id]', spec: validSpec('/revenue/[id]') }],
  }))
  assert.equal(r.ok, true, r.errors.join('; '))
})

// --- other kinds: structural validation ----------------------------------------

test('panel contribution validates structurally', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'panel', route: '/revenue', slot: 'aside', blocks: [{ kind: 'grid', blocks: [] }], sortOrder: 5 }],
  }))
  assert.equal(r.ok, true, r.errors.join('; '))
  const c = r.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'panel' }>
  assert.equal(c.sortOrder, 5)
})

test('panel contribution rejects a bad slot', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'panel', route: '/revenue', slot: 'Not A Slug', blocks: [] }],
  }))
  assert.equal(r.ok, false)
})

test('record-type contribution requires sections', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'record-type', key: 'wip-transactions', label: 'WIP Transactions', sections: [{ id: 'main', title: 'Main', repeating: false, fields: [{ id: 'name', type: 'text', label: 'Name' }] }] }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))

  const empty = parseModuleManifest(base({
    contributions: [{ kind: 'record-type', key: 'wip-transactions', label: 'WIP', sections: [] }],
  }))
  assert.equal(empty.ok, false)
})

test('field contribution validates against the custom_field_defs vocabulary', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'field', targetTable: 'documents', targetKind: 'vendor_bill', key: 'recast_bucket', label: 'Recast bucket', fieldType: 'select', config: { options: [{ value: 'a', label: 'A' }] } }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))
  const c = ok.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'field' }>
  assert.equal(c.isRequired, false)

  const badType = parseModuleManifest(base({
    contributions: [{ kind: 'field', targetTable: 'documents', key: 'x', label: 'X', fieldType: 'hologram' }],
  }))
  assert.equal(badType.ok, false)

  const badKey = parseModuleManifest(base({
    contributions: [{ kind: 'field', targetTable: 'documents', key: 'CamelCase', label: 'X', fieldType: 'text' }],
  }))
  assert.equal(badKey.ok, false)
})

test('report contribution validates slug and types', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'report', slug: 'recast-summary', name: 'Recast Summary', reportType: 'query', query: { entity: 'documents', columns: ['id'] } }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))
  const c = ok.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'report' }>
  assert.equal(c.reportType, 'query')

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'report', slug: 'Bad Slug', name: 'X' }],
  }))
  assert.equal(bad.ok, false)
})

test('card contribution validates viz type', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'card', name: 'Recast backlog', query: { source: 'documents' }, vizType: 'bar' }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))
  const c = ok.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'card' }>
  assert.equal(c.vizType, 'bar')
  assert.deepEqual(c.vizSettings, {})

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'card', name: 'X', query: {}, vizType: 'hologram' }],
  }))
  assert.equal(bad.ok, false)
})

test('job contribution requires a cron-shaped string', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'job', name: 'Nightly recast', cron: '0 3 * * *' }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))
  const c = ok.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'job' }>
  assert.equal(c.timeoutMs, 30_000)

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'job', name: 'X', cron: 'whenever' }],
  }))
  assert.equal(bad.ok, false)
})

test('endpoint contribution defaults method', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'endpoint', path: 'recast-totals' }],
  }))
  assert.equal(r.ok, true, r.errors.join('; '))
  const c = r.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'endpoint' }>
  assert.equal(c.method, 'ANY')
})

test('hook contribution validates the trigger vocabulary', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'hook', trigger: 'after_post', path: 'index', sortOrder: 50 }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'hook', trigger: 'on_reassembly', path: 'index' }],
  }))
  assert.equal(bad.ok, false)
})

test('flow contribution accepts a graph payload', () => {
  const r = parseModuleManifest(base({
    contributions: [{ kind: 'flow', name: 'Bill recast gate', subjectKind: 'vendor_bill', graph: { schemaVersion: 1, nodes: [], edges: [] } }],
  }))
  assert.equal(r.ok, true, r.errors.join('; '))
  const c = r.manifest!.contributions[0] as Extract<ModuleContribution, { kind: 'flow' }>
  assert.equal(c.enabled, true)
})

test('agent contribution validates key and cadence', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'agent', key: 'reconciler', name: 'Reconciler', cadence: 'weekly', settings: { threshold: 100 } }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'agent', key: 'Reconciler!', name: 'X' }],
  }))
  assert.equal(bad.ok, false)
})

test('permission contribution requires a hierarchical key', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'permission', key: 'revenue.recast', label: 'Recast revenue' }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'permission', key: 'recast', label: 'X' }],
  }))
  assert.equal(bad.ok, false)
})

test('setting contribution validates value type', () => {
  const ok = parseModuleManifest(base({
    contributions: [{ kind: 'setting', key: 'recast_enabled', label: 'Recast enabled', valueType: 'boolean', defaultValue: false }],
  }))
  assert.equal(ok.ok, true, ok.errors.join('; '))

  const bad = parseModuleManifest(base({
    contributions: [{ kind: 'setting', key: 'recast_enabled', label: 'X', valueType: 'hologram' }],
  }))
  assert.equal(bad.ok, false)
})

// --- cross-contribution rules ---------------------------------------------------

test('duplicate page routes are rejected', () => {
  const r = parseModuleManifest(base({
    contributions: [
      { kind: 'page', route: '/x', spec: validSpec('/x') },
      { kind: 'page', route: '/x', spec: validSpec('/x') },
    ],
  }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /duplicate page contribution route/)
})

test('same route different slots is fine; same route+slot collides', () => {
  const fine = parseModuleManifest(base({
    contributions: [
      { kind: 'panel', route: '/x', slot: 'aside', blocks: [] },
      { kind: 'panel', route: '/x', slot: 'header', blocks: [] },
    ],
  }))
  assert.equal(fine.ok, true, fine.errors.join('; '))

  const collide = parseModuleManifest(base({
    contributions: [
      { kind: 'panel', route: '/x', slot: 'aside', blocks: [] },
      { kind: 'panel', route: '/x', slot: 'aside', blocks: [] },
    ],
  }))
  assert.equal(collide.ok, false)
  assert.match(collide.errors.join('\n'), /duplicate/)
})

test('duplicate field keys on the same target are rejected', () => {
  const r = parseModuleManifest(base({
    contributions: [
      { kind: 'field', targetTable: 'documents', targetKind: 'vendor_bill', key: 'bucket', label: 'B1', fieldType: 'text' },
      { kind: 'field', targetTable: 'documents', targetKind: 'vendor_bill', key: 'bucket', label: 'B2', fieldType: 'text' },
    ],
  }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /duplicate field contribution key/)
})

test('duplicate endpoint paths are rejected', () => {
  const r = parseModuleManifest(base({
    contributions: [
      { kind: 'endpoint', path: 'totals' },
      { kind: 'endpoint', path: 'totals' },
    ],
  }))
  assert.equal(r.ok, false)
  assert.match(r.errors.join('\n'), /duplicate endpoint contribution path/)
})

// --- projection statuses ---------------------------------------------------------

test('projectionStatuses: page is projected, everything else NOT_IMPLEMENTED_YET', () => {
  const r = parseModuleManifest(base({
    contributions: [
      { kind: 'page', route: '/x', spec: validSpec('/x') },
      { kind: 'job', name: 'N', cron: '0 3 * * *' },
      { kind: 'setting', key: 'k', label: 'L', valueType: 'boolean' },
    ],
  }))
  assert.equal(r.ok, true)
  const statuses = projectionStatuses(r.manifest!)
  assert.equal(statuses[0]!.status, 'projected')
  assert.equal(statuses[0]!.target, 'page_specs')
  assert.equal(statuses[1]!.status, 'NOT_IMPLEMENTED_YET')
  assert.match(statuses[1]!.target, /user_scripts/)
  assert.equal(statuses[2]!.status, 'NOT_IMPLEMENTED_YET')

  const summary = projectionSummary(r.manifest!)
  assert.deepEqual(summary, { projected: 1, notImplementedYet: 2 })
})

test('projectionSummary counts an empty manifest as zero/zero', () => {
  const r = parseModuleManifest(base())
  assert.equal(r.ok, true)
  assert.deepEqual(projectionSummary(r.manifest!), { projected: 0, notImplementedYet: 0 })
  assert.deepEqual(projectionStatuses(r.manifest!), [])
})

// --- every kind round-trips through the schema -----------------------------------

test('a manifest with one of every contribution kind parses and summarizes', () => {
  const r = parseModuleManifest(base({
    contributions: [
      { kind: 'page', route: '/x', spec: validSpec('/x') },
      { kind: 'panel', route: '/x', slot: 'aside', blocks: [] },
      { kind: 'record-type', key: 'wip-transactions', label: 'WIP', sections: [{ id: 's', title: 'S', repeating: false, fields: [] }] },
      { kind: 'field', targetTable: 'documents', key: 'bucket', label: 'Bucket', fieldType: 'text' },
      { kind: 'report', slug: 'recast', name: 'Recast' },
      { kind: 'card', name: 'Backlog', query: {} },
      { kind: 'job', name: 'Nightly', cron: '0 3 * * *' },
      { kind: 'endpoint', path: 'totals' },
      { kind: 'hook', trigger: 'after_post', path: 'index' },
      { kind: 'flow', name: 'Gate', subjectKind: 'vendor_bill', graph: {} },
      { kind: 'agent', key: 'reconciler', name: 'Reconciler' },
      { kind: 'permission', key: 'revenue.recast', label: 'Recast' },
      { kind: 'setting', key: 'recast_enabled', label: 'Recast', valueType: 'boolean' },
    ],
  }))
  assert.equal(r.ok, true, r.errors.join('; '))
  assert.equal(r.manifest!.contributions.length, 13)
  assert.deepEqual(projectionSummary(r.manifest!), { projected: 1, notImplementedYet: 12 })
})

test('moduleManifestSchema type inference compiles with every kind', () => {
  const m: ModuleManifest = moduleManifestSchema.parse(base({
    contributions: [{ kind: 'page', route: '/x', spec: validSpec('/x') }],
  }))
  assert.equal(m.contributions[0]!.kind, 'page')
})
