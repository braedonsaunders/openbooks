import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// resolveListView is server-only and database-backed; the database (never
// validation) is stubbed, while the pure untouched rule and the live registry
// run for real. react cache keys on arguments, so every case uses its own org.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = globalThis.__resolveSeedDb',
      }
    }
    return nextResolve(specifier, context)
  },
})

type Row = Record<string, unknown>
;(globalThis as Record<string, unknown>).__resolveSeedDb = {
  calls: 0,
  viewRows: [] as Row[],
  prefViewId: null as string | null,
  async execute() {
    const state = (globalThis as Record<string, unknown>).__resolveSeedDb as {
      calls: number
      viewRows: Row[]
      prefViewId: string | null
    }
    state.calls += 1
    // First query lists the views; the second (when no explicit view) reads
    // the user's default preference.
    if (state.calls === 1) return { rows: state.viewRows }
    return { rows: state.prefViewId ? [{ viewId: state.prefViewId }] : [] }
  },
}

const { resolveListView } = await import('./resolve.ts')
const { defaultListView, stripSeededDefaultMark } = await import('@openbooks/customization')

const AT = new Date('2025-01-01T00:00:00Z')
const LATER = new Date('2025-02-01T00:00:00Z')
const seedShape = defaultListView('employee')
const staleDescSeed = { ...seedShape, sort: { column: 'display_name', dir: 'desc' } }

function seedRow(overrides: Row = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Default view',
    recordType: 'employee',
    scope: 'org',
    ownerId: null,
    isDefault: true,
    isActive: true,
    config: staleDescSeed,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  }
}

async function resolve(overrides: { viewRows: Row[]; prefViewId?: string | null; viewId?: string | null }, org: string) {
  const state = (globalThis as Record<string, unknown>).__resolveSeedDb as {
    calls: number
    viewRows: Row[]
    prefViewId: string | null
  }
  state.calls = 0
  state.viewRows = overrides.viewRows
  state.prefViewId = overrides.prefViewId ?? null
  return resolveListView({
    orgId: org,
    userId: 'user-1',
    recordType: 'employee',
    viewId: overrides.viewId ?? null,
    showInListDefs: [],
  })
}

// Case 1: an untouched old seed (equal timestamps, pristine shape, stale
// desc sort) resolves to the LIVE registry default — A→Z, not the snapshot.
test('untouched old seed resolves to the live registry default', async () => {
  const resolved = await resolve({ viewRows: [seedRow()] }, 'org-case-1')
  assert.equal(resolved.source, 'org')
  assert.deepEqual(resolved.view.sort, { column: 'display_name', dir: 'asc' })
  assert.equal(resolved.row?.id, seedRow().id)
  assert.equal(resolved.row?.name, 'Default view')
})

// Case 2: an untouched new seed (marked) resolves live without the heuristic.
test('untouched marked seed resolves to the live registry default', async () => {
  const marked = { ...staleDescSeed, seededDefault: true }
  const resolved = await resolve(
    { viewRows: [seedRow({ config: marked, updatedAt: LATER })] },
    'org-case-2',
  )
  assert.equal(resolved.source, 'org')
  assert.deepEqual(resolved.view.sort, { column: 'display_name', dir: 'asc' })
})

// Case 3: a row edited only in sort keeps its sort.
test('sort-only edit keeps the stored sort', async () => {
  const stored = { ...seedShape, sort: { column: 'short_code', dir: 'desc' } }
  const resolved = await resolve(
    { viewRows: [seedRow({ config: stored, updatedAt: LATER })] },
    'org-case-3',
  )
  assert.equal(resolved.source, 'org')
  assert.deepEqual(resolved.view.sort, { column: 'short_code', dir: 'desc' })
})

// Case 4: a row with a customised column keeps everything, even when the
// timestamps alone would call it untouched.
test('customised column keeps the whole stored view', async () => {
  const stored = {
    ...staleDescSeed,
    perPage: 50,
    columns: seedShape.columns.map((c) => (c.key === 'display_name' ? { ...c, labelOverride: 'Staff' } : c)),
  }
  const resolved = await resolve({ viewRows: [seedRow({ config: stored })] }, 'org-case-4')
  assert.equal(resolved.source, 'org')
  assert.deepEqual(resolved.view.sort, { column: 'display_name', dir: 'desc' })
  assert.equal(resolved.view.perPage, 50)
  assert.equal(
    resolved.view.columns.find((c) => c.key === 'display_name')?.labelOverride,
    'Staff',
  )
})

// User-scoped views are never substituted: the preference path serves the
// stored personal view verbatim.
test('user views resolve stored, never live', async () => {
  const personal = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Mine',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: false,
    isActive: true,
    config: { ...seedShape, perPage: 50, sort: { column: 'short_code', dir: 'desc' } },
    createdAt: AT,
    updatedAt: AT,
  }
  const resolved = await resolve(
    { viewRows: [seedRow(), personal], prefViewId: personal.id as string },
    'org-case-5',
  )
  assert.equal(resolved.source, 'user')
  assert.equal(resolved.view.perPage, 50)
  assert.deepEqual(resolved.view.sort, { column: 'short_code', dir: 'desc' })
})

// Step 4 ("first available") no longer promotes an arbitrary non-default
// view over the system default.
test('no default falls back to the system default, not first available', async () => {
  const other = seedRow({
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Someone else',
    isDefault: false,
    config: { ...seedShape, sort: { column: 'short_code', dir: 'desc' } },
    updatedAt: LATER,
  })
  const resolved = await resolve({ viewRows: [other] }, 'org-case-6')
  assert.equal(resolved.source, 'system')
  assert.equal(resolved.row, null)
  assert.deepEqual(resolved.view.sort, { column: 'display_name', dir: 'asc' })
  assert.equal(resolved.available.length, 1)
})

// An explicit pick of the untouched seed goes live too, keeping its identity.
test('explicit pick of an untouched seed resolves live as explicit', async () => {
  const seed = seedRow()
  const resolved = await resolve({ viewRows: [seed], viewId: seed.id as string }, 'org-case-7')
  assert.equal(resolved.source, 'explicit')
  assert.deepEqual(resolved.view.sort, { column: 'display_name', dir: 'asc' })
  assert.equal(resolved.row?.id, seed.id)
})

// The full PATCH round trip: a seeded default edited only in sort direction
// is stored by PATCH without the mark (stripped explicitly in the route) and
// with a bumped updated_at — so resolution keeps the edited direction even
// though the shape rule alone would pass.
test('a sort-only edit through the PATCH path keeps its direction', async () => {
  const editedThroughPatch = stripSeededDefaultMark({
    ...staleDescSeed,
    seededDefault: true,
    sort: { column: 'short_code', dir: 'desc' as const },
  })
  assert.ok(!('seededDefault' in (editedThroughPatch as Record<string, unknown>)))
  const resolved = await resolve(
    { viewRows: [seedRow({ config: editedThroughPatch, updatedAt: LATER })] },
    'org-case-8',
  )
  assert.equal(resolved.source, 'org')
  assert.deepEqual(resolved.view.sort, { column: 'short_code', dir: 'desc' })
})
