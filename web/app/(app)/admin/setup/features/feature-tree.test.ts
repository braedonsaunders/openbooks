import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFeatureTree,
  featureSearchMatcher,
  filterFeatureTree,
  industryLenses,
  OTHER_INDUSTRY_MODULES,
  resolveFeatureOn,
  type FeatureTreeRow,
} from './feature-tree'
import { FEATURE_CATEGORIES as CATEGORIES, FEATURES } from '../../../../../../engine/src/organization/feature-registry'
import { INDUSTRIES } from '../../../../../lib/industries'

const ROWS: FeatureTreeRow[] = [
  { key: 'projects', category: 'projects' },
  { key: 'timeTracking', category: 'projects', parentKey: 'projects' },
  { key: 'fieldTickets', category: 'projects', parentKey: 'projects' },
  { key: 'projectScheduling', category: 'projects', parentKey: 'projects' },
  { key: 'subcontracts', category: 'projects', requiresAll: ['projects'] },
  { key: 'inventory', category: 'projects' },
  { key: 'flows', category: 'platform' },
  { key: 'advancedClose', category: 'finance', parentKey: 'flows' },
  { key: 'allocations', category: 'finance' },
  { key: 'allocationsAtEntry', category: 'finance', parentKey: 'allocations' },
  { key: 'allocationsAtPosting', category: 'finance', parentKey: 'allocations' },
]

const ALL_ON: Record<string, boolean> = Object.fromEntries(ROWS.map((r) => [r.key, true]))

function sectionFor(category: string, rows: FeatureTreeRow[] = ROWS, state: Record<string, boolean> = ALL_ON) {
  return buildFeatureTree(rows, state, CATEGORIES).find((s) => s.category === category)
}

test('children nest directly under their parent in registry order', () => {
  const ops = sectionFor('projects')!
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
  const ops = sectionFor('projects')!
  const subcontracts = ops.groups.find((g) => g.parent.row.key === 'subcontracts')!
  assert.equal(subcontracts.children.length, 0)
  // A requiresAll row resolves off while its requirement is off (engine fails closed).
  assert.equal(resolveFeatureOn(ROWS, { ...ALL_ON, projects: false }, 'subcontracts'), false)
})

test('children are hidden while the parent is off, without touching stored values', () => {
  const state = { ...ALL_ON, projects: false }
  const input = ROWS.map((r) => ({ ...r }))
  const ops = buildFeatureTree(input, state, CATEGORIES).find((s) => s.category === 'projects')!
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
  const ops = sectionFor('projects')!
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
    (s) => s.category === 'projects',
  )!
  // projects + subcontracts + inventory visible; the three project children hidden.
  // Only inventory resolves on: subcontracts requires the (off) projects gate.
  assert.equal(hidden.visibleTotal, 3)
  assert.equal(hidden.visibleOn, 1)
  const shown = sectionFor('projects')!
  assert.equal(shown.visibleTotal, 6)
  assert.equal(shown.visibleOn, 6)
})

test('a child that is itself switched off counts as off, not hidden', () => {
  const ops = buildFeatureTree(ROWS, { ...ALL_ON, timeTracking: false }, CATEGORIES).find(
    (s) => s.category === 'projects',
  )!
  assert.equal(ops.visibleTotal, 6)
  assert.equal(ops.visibleOn, 5)
})

test('a child declared on another tab is a top-level row on its own tab', () => {
  // advancedClose is a finance capability subordinate to flows (platform):
  // it renders where its category says, gated by its requirement.
  const platform = sectionFor('platform')!
  const flows = platform.groups.find((g) => g.parent.row.key === 'flows')!
  assert.deepEqual(flows.children, [])
  const finance = sectionFor('finance')!
  assert.deepEqual(
    finance.groups.map((g) => g.parent.row.key),
    ['advancedClose', 'allocations'],
  )
  const flowsOff = buildFeatureTree(ROWS, { ...ALL_ON, flows: false }, CATEGORIES).find((s) => s.category === 'finance')!
  const advancedClose = flowsOff.groups[0]!.parent
  assert.equal(advancedClose.visible, true)
  assert.equal(advancedClose.on, false)
  assert.deepEqual(advancedClose.missingRequirements, ['flows'])
})

test('every real registry feature renders exactly once, on the tab its category names', () => {
  const rows: FeatureTreeRow[] = FEATURES.map((f) => ({
    key: f.key,
    category: f.category,
    parentKey: f.parentKey,
    requiresAll: f.requiresAll,
  }))
  const state: Record<string, boolean> = Object.fromEntries(FEATURES.map((f) => [f.key, f.defaultEnabled]))
  const sections = buildFeatureTree(rows, state, CATEGORIES)
  assert.deepEqual(
    sections.map((s) => s.category),
    [...CATEGORIES],
    'every tab has features and tabs keep registry order',
  )
  const placed = sections.flatMap((s) =>
    s.groups.flatMap((g) => [g.parent, ...g.children].map((node) => ({ key: node.row.key, tab: s.category }))),
  )
  assert.equal(placed.length, FEATURES.length, 'no feature is dropped or duplicated')
  const byKey = new Map(FEATURES.map((f) => [f.key, f]))
  for (const { key, tab } of placed) assert.equal(tab, byKey.get(key)!.category, `${key} renders on its own tab`)
  const nested = new Set(sections.flatMap((s) => s.groups.flatMap((g) => g.children.map((c) => c.row.key))))
  for (const f of FEATURES) {
    const parent = f.parentKey ? byKey.get(f.parentKey) : undefined
    if (parent?.category === f.category) assert.ok(nested.has(f.key), `${f.key} should nest under ${f.parentKey}`)
    else assert.ok(!nested.has(f.key), `${f.key} has no same-tab parent and stays top-level`)
  }
})

const TITLES: Record<string, string> = {
  projects: 'Projects',
  timeTracking: 'Time tracking',
  fieldTickets: 'Field tickets',
  projectScheduling: 'Project scheduling',
  subcontracts: 'Subcontracts',
  inventory: 'Inventory',
  flows: 'Flows',
  advancedClose: 'Advanced close',
  allocations: 'Allocations',
  allocationsAtEntry: 'Allocate at entry',
  allocationsAtPosting: 'Allocate at posting',
}
const searchFor = (query: string, state: Record<string, boolean> = ALL_ON) => {
  const matcher = featureSearchMatcher(query, (row) => [TITLES[row.key]!])
  assert.ok(matcher)
  return filterFeatureTree(buildFeatureTree(ROWS, state, CATEGORIES), matcher)
}

test('search spans every tab and drops tabs with no match', () => {
  const results = searchFor('at')
  assert.deepEqual(
    results.map((s) => [s.category, s.groups.flatMap((g) => [g.parent, ...g.visibleChildren].map((n) => n.row.key))]),
    [['finance', ['allocations', 'allocationsAtEntry', 'allocationsAtPosting']]],
  )
  assert.deepEqual(searchFor('nothing like this'), [])
})

test('a matching parent keeps its children; a matching child keeps only itself under its parent', () => {
  const parent = searchFor('allocations')
  assert.equal(parent[0]!.groups[0]!.visibleChildren.length, 2)
  const child = searchFor('field')
  assert.deepEqual(child[0]!.groups.map((g) => g.parent.row.key), ['projects'])
  assert.deepEqual(child[0]!.groups[0]!.visibleChildren.map((c) => c.row.key), ['fieldTickets'])
  assert.equal(child[0]!.visibleTotal, 2)
})

test('search finds a child hidden behind an off parent and shows it locked', () => {
  const results = searchFor('scheduling', { ...ALL_ON, projects: false })
  const group = results[0]!.groups[0]!
  const scheduling = group.visibleChildren[0]!
  assert.equal(scheduling.row.key, 'projectScheduling')
  assert.equal(scheduling.visible, true)
  assert.equal(scheduling.on, false, 'a child can never read on while its parent is off')
  assert.deepEqual(scheduling.missingRequirements, ['projects'])
  assert.equal(group.hiddenChildCount, 0)
})

test('search terms all must match, ignoring case and accents; a blank query filters nothing', () => {
  const text = (row: FeatureTreeRow) => [row.key === 'a' ? 'Résumé parsing' : 'Payroll']
  const matcher = featureSearchMatcher('  RESUME   pars ', text)!
  assert.equal(matcher({ key: 'a', category: 'people' }), true)
  assert.equal(featureSearchMatcher('resume payroll', text)!({ key: 'a', category: 'people' }), false)
  assert.equal(featureSearchMatcher('   ', text), null)
})

test('orphan children (unknown parent) stay visible as top-level rows', () => {
  const rows: FeatureTreeRow[] = [
    { key: 'lonely', category: 'projects', parentKey: 'missing-parent' },
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

const lensKeys = (lens: { section: ReturnType<typeof buildFeatureTree>[number] }) =>
  lens.section.groups.flatMap((g) => [g.parent, ...g.visibleChildren].map((n) => n.row.key))

test('industry lenses lead with the org industry and gather unnamed industry modules last', () => {
  const rows: FeatureTreeRow[] = [
    ...ROWS,
    { key: 'nonprofit', category: 'industries' },
    { key: 'fundAccounting', category: 'industries', parentKey: 'nonprofit' },
    { key: 'propertyManagement', category: 'industries' },
  ]
  const state = Object.fromEntries(rows.map((r) => [r.key, true]))
  const lenses = industryLenses(
    buildFeatureTree(rows, state, CATEGORIES),
    [
      { key: 'construction_contractor', features: ['projects', 'fieldTickets', 'subcontracts', 'inventory'] },
      { key: 'nonprofit', features: ['nonprofit', 'allocations'] },
      { key: 'unknown_vertical', features: ['notARegisteredFeature'] },
    ],
    'nonprofit',
  )
  assert.deepEqual(
    lenses.map((lens) => [lens.key, lensKeys(lens)]),
    [
      // Tab order across tabs; a named parent brings its children.
      ['nonprofit', ['allocations', 'allocationsAtEntry', 'allocationsAtPosting', 'nonprofit', 'fundAccounting']],
      ['construction_contractor', ['projects', 'timeTracking', 'fieldTickets', 'projectScheduling', 'subcontracts', 'inventory']],
      [OTHER_INDUSTRY_MODULES, ['propertyManagement']],
    ],
  )
})

test('the real Industries tab names only registered features and carries every industry module', () => {
  const registered = new Set(FEATURES.map((f) => f.key))
  const industries = INDUSTRIES.map((industry) => ({
    key: industry.key,
    features: Object.entries(industry.features).filter(([, on]) => on).map(([key]) => key),
  }))
  for (const industry of industries) {
    for (const key of industry.features) {
      assert.ok(registered.has(key), `${industry.key} presets ${key}, which is not a registered feature`)
    }
  }
  const rows: FeatureTreeRow[] = FEATURES.map((f) => ({ key: f.key, category: f.category, parentKey: f.parentKey, requiresAll: f.requiresAll }))
  const state = Object.fromEntries(FEATURES.map((f) => [f.key, true]))
  const shown = new Set(industryLenses(buildFeatureTree(rows, state, CATEGORIES), industries, null).flatMap(lensKeys))
  for (const f of FEATURES.filter((f) => f.category === 'industries')) {
    assert.ok(shown.has(f.key), `${f.key} is an industry module the Industries tab must show`)
  }
})
