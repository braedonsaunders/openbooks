import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFeatureTree,
  resolveFeatureOn,
  type FeatureTreeRow,
} from './feature-tree'
import { FEATURES } from '../../../../../../engine/src/feature-registry'

const CATEGORIES = ['sales', 'operations', 'accounting', 'platform'] as const

const ROWS: FeatureTreeRow[] = [
  { key: 'projects', category: 'operations' },
  { key: 'timeTracking', category: 'operations', parentKey: 'projects' },
  { key: 'fieldTickets', category: 'operations', parentKey: 'projects' },
  { key: 'projectScheduling', category: 'operations', parentKey: 'projects' },
  { key: 'subcontracts', category: 'operations', requiresAll: ['projects'] },
  { key: 'inventory', category: 'operations' },
  { key: 'flows', category: 'platform' },
  { key: 'advancedClose', category: 'accounting', parentKey: 'flows' },
  { key: 'allocations', category: 'accounting' },
  { key: 'allocationsAtEntry', category: 'accounting', parentKey: 'allocations' },
  { key: 'allocationsAtPosting', category: 'accounting', parentKey: 'allocations' },
]

const ALL_ON: Record<string, boolean> = Object.fromEntries(ROWS.map((r) => [r.key, true]))

function sectionFor(category: string, rows: FeatureTreeRow[] = ROWS, state: Record<string, boolean> = ALL_ON) {
  return buildFeatureTree(rows, state, CATEGORIES).find((s) => s.category === category)
}

test('children nest directly under their parent in registry order', () => {
  const ops = sectionFor('operations')!
  assert.deepEqual(
    ops.groups.map((g) => g.parent.row.key),
    ['projects', 'subcontracts', 'inventory'],
  )
  const projects = ops.groups[0]!
  assert.deepEqual(
    projects.children.map((c) => c.row.key),
    ['timeTracking', 'fieldTickets', 'projectScheduling'],
  )
})

test('requiresAll dependencies stay top-level, never nested', () => {
  const ops = sectionFor('operations')!
  const subcontracts = ops.groups.find((g) => g.parent.row.key === 'subcontracts')!
  assert.equal(subcontracts.children.length, 0)
  // A requiresAll row resolves off while its requirement is off (engine fails closed).
  assert.equal(resolveFeatureOn(ROWS, { ...ALL_ON, projects: false }, 'subcontracts'), false)
})

test('children are hidden while the parent is off, without touching stored values', () => {
  const state = { ...ALL_ON, projects: false }
  const input = ROWS.map((r) => ({ ...r }))
  const ops = buildFeatureTree(input, state, CATEGORIES).find((s) => s.category === 'operations')!
  const projects = ops.groups[0]!
  assert.equal(projects.parent.on, false)
  assert.deepEqual(projects.visibleChildren, [])
  assert.equal(projects.hiddenChildCount, 3)
  // Pure view model: the stored switch state is never mutated by hiding.
  assert.deepEqual(state, { ...ALL_ON, projects: false })
  assert.deepEqual(
    input.map((r) => r.key),
    ROWS.map((r) => r.key),
  )
})

test('children appear once the parent turns on', () => {
  const ops = sectionFor('operations')!
  const projects = ops.groups[0]!
  assert.equal(projects.parent.on, true)
  assert.equal(projects.hiddenChildCount, 0)
  assert.deepEqual(
    projects.visibleChildren.map((c) => c.row.key),
    ['timeTracking', 'fieldTickets', 'projectScheduling'],
  )
})

test('category counts cover only visible rows', () => {
  const hidden = buildFeatureTree(ROWS, { ...ALL_ON, projects: false }, CATEGORIES).find(
    (s) => s.category === 'operations',
  )!
  // projects + subcontracts + inventory visible; the three project children hidden.
  // Only inventory resolves on: subcontracts requires the (off) projects gate.
  assert.equal(hidden.visibleTotal, 3)
  assert.equal(hidden.visibleOn, 1)
  const shown = sectionFor('operations')!
  assert.equal(shown.visibleTotal, 6)
  assert.equal(shown.visibleOn, 6)
})

test('a child that is itself switched off counts as off, not hidden', () => {
  const ops = buildFeatureTree(ROWS, { ...ALL_ON, timeTracking: false }, CATEGORIES).find(
    (s) => s.category === 'operations',
  )!
  assert.equal(ops.visibleTotal, 6)
  assert.equal(ops.visibleOn, 5)
})

test('cross-category children render in the parent section', () => {
  // advancedClose lives in accounting but is subordinate to flows (platform).
  const platform = buildFeatureTree(ROWS, ALL_ON, CATEGORIES).find((s) => s.category === 'platform')!
  const flows = platform.groups.find((g) => g.parent.row.key === 'flows')!
  assert.deepEqual(
    flows.visibleChildren.map((c) => c.row.key),
    ['advancedClose'],
  )
  const accounting = buildFeatureTree(ROWS, ALL_ON, CATEGORIES).find((s) => s.category === 'accounting')!
  assert.deepEqual(
    accounting.groups.map((g) => g.parent.row.key),
    ['allocations'],
  )
})

test('every parentKey in the real registry nests under a known parent', () => {
  const rows: FeatureTreeRow[] = FEATURES.map((f) => ({
    key: f.key,
    category: f.category,
    parentKey: f.parentKey,
    requiresAll: f.requiresAll,
  }))
  const state: Record<string, boolean> = Object.fromEntries(FEATURES.map((f) => [f.key, f.defaultEnabled]))
  const sections = buildFeatureTree(rows, state, CATEGORIES)
  const nested = new Set(sections.flatMap((s) => s.groups.flatMap((g) => g.children.map((c) => c.row.key))))
  for (const f of FEATURES) {
    if (f.parentKey) assert.ok(nested.has(f.key), `${f.key} should nest under ${f.parentKey}`)
  }
  const tops = new Set(sections.flatMap((s) => s.groups.map((g) => g.parent.row.key)))
  for (const f of FEATURES) {
    if (f.requiresAll && !f.parentKey) assert.ok(tops.has(f.key), `${f.key} (requiresAll) stays top-level`)
  }
  // Registry parents in registry order (flows sorts last: it is declared
  // after allocations in the registry even though advancedClose is accounting).
  assert.deepEqual(
    [...tops].filter((key) => rows.some((r) => r.parentKey === key)),
    ['projects', 'allocations', 'flows'],
  )
})

test('orphan children (unknown parent) stay visible as top-level rows', () => {
  const rows: FeatureTreeRow[] = [
    { key: 'lonely', category: 'operations', parentKey: 'missing-parent' },
  ]
  const sections = buildFeatureTree(rows, { lonely: true }, CATEGORIES)
  assert.equal(sections.length, 1)
  assert.equal(sections[0]!.groups[0]!.parent.row.key, 'lonely')
  assert.equal(sections[0]!.visibleTotal, 1)
  // Fail closed like the engine: the unknown parent can never resolve on,
  // but the row stays visible (with its missing requirement) instead of vanishing.
  assert.equal(sections[0]!.visibleOn, 0)
  assert.deepEqual(sections[0]!.groups[0]!.parent.missingRequirements, ['missing-parent'])
})
