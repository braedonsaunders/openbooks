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
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
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
  // A present row with view_id NULL is "use system default" (schema:
  // null viewId ⇒ org default). That is not the same as no preference row.
  prefCleared: false,
  async execute() {
    const state = (globalThis as Record<string, unknown>).__resolveSeedDb as {
      calls: number
      viewRows: Row[]
      prefViewId: string | null
      prefCleared: boolean
    }
    state.calls += 1
    // First query lists the views; the second (when no explicit view) reads
    // the user's default preference.
    if (state.calls === 1) return { rows: state.viewRows }
    if (state.prefCleared) return { rows: [{ viewId: null }] }
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

async function resolve(
  overrides: { viewRows: Row[]; prefViewId?: string | null; prefCleared?: boolean; viewId?: string | null },
  org: string,
) {
  const state = (globalThis as Record<string, unknown>).__resolveSeedDb as {
    calls: number
    viewRows: Row[]
    prefViewId: string | null
    prefCleared: boolean
  }
  state.calls = 0
  state.viewRows = overrides.viewRows
  state.prefViewId = overrides.prefViewId ?? null
  state.prefCleared = overrides.prefCleared === true
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

// A designer "default for its scope" on a personal view writes isDefault on
// the user-scope row. That flag is the personal default: when no explicit
// preference is set it must win over the org default, or the save stored a
// flag no resolve can observe.
test('a personal isDefault is the user default when no preference is set', async () => {
  const personal = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Mine',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 50, sort: { column: 'short_code', dir: 'desc' } },
    createdAt: AT,
    updatedAt: AT,
  }
  const resolved = await resolve({ viewRows: [seedRow(), personal] }, 'org-case-9')
  assert.equal(resolved.source, 'user')
  assert.equal(resolved.row?.id, personal.id)
  assert.equal(resolved.view.perPage, 50)
  assert.deepEqual(resolved.view.sort, { column: 'short_code', dir: 'desc' })
})

// The views-menu preference is the more specific "I chose this view" write
// and still outranks a personal isDefault (it can point at an org view).
test('an explicit list preference outranks a personal isDefault', async () => {
  const personal = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Mine',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 50 },
    createdAt: AT,
    updatedAt: AT,
  }
  const orgDefault = seedRow()
  const resolved = await resolve(
    { viewRows: [orgDefault, personal], prefViewId: orgDefault.id as string },
    'org-case-10',
  )
  assert.equal(resolved.source, 'org')
  assert.equal(resolved.row?.id, orgDefault.id)
})

// A personal default with no org default must still apply — otherwise the
// only observable read is the system registry, and the stored flag is dead.
test('a personal isDefault is applied when no org default exists', async () => {
  const personal = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Mine only',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 75 },
    createdAt: AT,
    updatedAt: AT,
  }
  const resolved = await resolve({ viewRows: [personal] }, 'org-case-11')
  assert.equal(resolved.source, 'user')
  assert.equal(resolved.row?.id, personal.id)
  assert.equal(resolved.view.perPage, 75)
})

// A personal view that is not the scope default must not steal the org
// default — otherwise any saved personal view would silently become the list.
test('a non-default personal view does not outrank the org default', async () => {
  const personal = {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Just mine',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: false,
    isActive: true,
    config: { ...seedShape, perPage: 50 },
    createdAt: AT,
    updatedAt: AT,
  }
  const orgDefault = seedRow()
  const resolved = await resolve({ viewRows: [orgDefault, personal] }, 'org-case-12')
  assert.equal(resolved.source, 'org')
  assert.equal(resolved.row?.id, orgDefault.id)
})

// An explicit ?view= still wins over a personal isDefault.
test('an explicit view outranks a personal isDefault', async () => {
  const personal = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Mine',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 50 },
    createdAt: AT,
    updatedAt: AT,
  }
  const orgDefault = seedRow()
  const resolved = await resolve(
    { viewRows: [orgDefault, personal], viewId: orgDefault.id as string },
    'org-case-13',
  )
  assert.equal(resolved.source, 'explicit')
  assert.equal(resolved.row?.id, orgDefault.id)
})

// Views-menu "use system default" writes a preference row with view_id NULL.
// That is an explicit refusal of every user default, including a personal
// isDefault — otherwise the clear cannot be observed.
test('a cleared preference skips the personal isDefault and uses the org default', async () => {
  const personal = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Mine',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 50 },
    createdAt: AT,
    updatedAt: AT,
  }
  const orgDefault = seedRow()
  const resolved = await resolve(
    { viewRows: [orgDefault, personal], prefCleared: true },
    'org-case-14',
  )
  assert.equal(resolved.source, 'org')
  assert.equal(resolved.row?.id, orgDefault.id)
})

test('a cleared preference with no org default uses the system default, not a personal isDefault', async () => {
  const personal = {
    id: '66666666-6666-4666-8666-666666666666',
    name: 'Mine only',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 75 },
    createdAt: AT,
    updatedAt: AT,
  }
  const resolved = await resolve({ viewRows: [personal], prefCleared: true }, 'org-case-15')
  assert.equal(resolved.source, 'system')
  assert.equal(resolved.row, null)
})

// Two personal isDefaults are overlapping configuration, not a default.
// Guessing the first by name would hide the race the write must refuse.
test('two personal isDefaults are ignored rather than guessed', async () => {
  const first = {
    id: '77777777-7777-4777-8777-777777777777',
    name: 'Alpha',
    recordType: 'employee',
    scope: 'user',
    ownerId: 'user-1',
    isDefault: true,
    isActive: true,
    config: { ...seedShape, perPage: 10 },
    createdAt: AT,
    updatedAt: AT,
  }
  const second = {
    ...first,
    id: '88888888-8888-4888-8888-888888888888',
    name: 'Beta',
    config: { ...seedShape, perPage: 20 },
  }
  const orgDefault = seedRow()
  const resolved = await resolve({ viewRows: [orgDefault, first, second] }, 'org-case-16')
  assert.equal(resolved.source, 'org')
  assert.equal(resolved.row?.id, orgDefault.id)
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
