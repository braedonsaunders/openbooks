import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { DOC_KIND_FEATURE } from './document-kinds'
import { MODULE_BY_KEY } from './nav/registry'
import {
  moduleDrawerHref,
  TRANSACTION_KINDS,
  TRANSACTION_MODULE_BY_KIND,
  transactionModule,
} from './txn-links'

interface CapturedQuery {
  text: string
  values: unknown[]
}

interface SearchFixture {
  id: string
  kind: string
  document_number: string
  reference_number: null
  memo: string
  status: 'posted'
  party_name: string | null
  amount: string
  subsidiary_id: string
  project_id: string | null
}

interface SearchTestState {
  disabledKinds: string[]
  documents: SearchFixture[]
  featureChecks: string[]
  features: Record<string, boolean>
  kindFeatures: Record<string, string>
  queries: CapturedQuery[]
}

const ALLOWED_SUBSIDIARY = '00000000-0000-0000-0000-000000000001'
const DENIED_SUBSIDIARY = '00000000-0000-0000-0000-000000000002'
const PROJECT_ID = '00000000-0000-0000-0000-000000000003'

const TRANSACTION_PERMISSIONS = [...new Set(TRANSACTION_KINDS.flatMap((kind) => {
  const permission = transactionModule(kind)?.requiredPermission
  return permission ? [permission] : []
}))]

const BASE_DOCUMENTS: SearchFixture[] = TRANSACTION_KINDS.map((kind, index) => ({
  id: kind,
  kind,
  document_number: kind.toUpperCase(),
  reference_number: null,
  memo: `${kind}:memo:confidential`,
  status: 'posted',
  party_name: `${kind}:counterparty:confidential`,
  amount: `${100 + index}.25`,
  subsidiary_id: ALLOWED_SUBSIDIARY,
  project_id: kind === 'project_charge' ? PROJECT_ID : null,
}))
const customerPayment = BASE_DOCUMENTS.find((row) => row.kind === 'customer_payment')!
customerPayment.party_name = null
customerPayment.memo = 'customer_payment:memo:confidential'
customerPayment.amount = '902.22'
const vendorPayment = BASE_DOCUMENTS.find((row) => row.kind === 'vendor_payment')!
vendorPayment.party_name = 'vendor_payment:counterparty:confidential'
vendorPayment.amount = '701.11'

const UNMAPPED_DOCUMENT: SearchFixture = {
  id: 'unmapped_document',
  kind: 'unmapped_document',
  document_number: 'UNMAPPED',
  reference_number: null,
  memo: 'unmapped:memo:confidential',
  status: 'posted',
  party_name: 'unmapped:counterparty:confidential',
  amount: '999.99',
  subsidiary_id: ALLOWED_SUBSIDIARY,
  project_id: null,
}

const stateKey = Symbol.for('openbooks.search-permission-test')
const state: SearchTestState = {
  disabledKinds: [],
  documents: [...BASE_DOCUMENTS, UNMAPPED_DOCUMENT],
  featureChecks: [],
  features: { banking: true, fieldTickets: true, projects: true },
  kindFeatures: { ...DOC_KIND_FEATURE } as Record<string, string>,
  queries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      function isFragment(value) {
        return value && typeof value === 'object'
          && typeof value.text === 'string' && Array.isArray(value.values)
      }

      function append(target, value) {
        if (isFragment(value)) {
          target.text += value.text
          target.values.push(...value.values)
        } else {
          target.text += '?'
          target.values.push(value)
        }
      }

      export function sql(strings, ...values) {
        const fragment = { text: '', values: [] }
        for (let index = 0; index < strings.length; index++) {
          fragment.text += strings[index]
          if (index < values.length) append(fragment, values[index])
        }
        return fragment
      }

      sql.join = function join(fragments, separator) {
        const joined = { text: '', values: [] }
        fragments.forEach((fragment, index) => {
          if (index > 0) append(joined, separator)
          append(joined, fragment)
        })
        return joined
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.search-permission-test')]

      export const db = {
        async execute(query) {
          state.queries.push({ text: query.text, values: [...query.values] })
          if (!query.text.includes('with cand as')) return { rows: [] }

          const knownKinds = new Set(state.documents.map((row) => row.kind))
          const boundKinds = new Set(query.values.filter((value) => knownKinds.has(value)))
          // With no kind predicate, PostgreSQL would search every document.
          // This makes the pre-fix shared permission gate reproduce the leak.
          let rows = boundKinds.size === 0
            ? state.documents
            : state.documents.filter((row) => boundKinds.has(row.kind))
          if (query.text.includes('and false')) rows = []

          const subsidiaryIds = new Set(query.values
            .filter((value) => typeof value === 'string' && /^\\{.*\\}$/.test(value))
            .flatMap((value) => value.slice(1, -1).split(',').filter(Boolean)))
          if (query.text.includes('d.subsidiary_id') && subsidiaryIds.size > 0) {
            rows = rows.filter((row) => subsidiaryIds.has(row.subsidiary_id))
          }
          return { rows }
        },
      }

      // subsidiaries.ts (loaded for real) uses this for identity lookups the
      // search never performs — authz arrives prebuilt in these tests.
      export async function withBypassContext(fn) {
        return fn()
      }
    `,
  ],
  [
    'mock:authz',
    `
      export function can(authz, permission) {
        if (authz.permissions.has('*') || authz.permissions.has(permission)) return true
        const namespace = permission.split('.')[0]
        return authz.permissions.has(namespace + '.*')
      }
    `,
  ],
  [
    'mock:documents',
    `
      const state = globalThis[Symbol.for('openbooks.search-permission-test')]
      export async function disabledDocKinds() {
        const featureDisabled = Object.entries(state.kindFeatures)
          .filter(([, feature]) => state.features[feature] === false)
          .map(([kind]) => kind)
        return [...new Set([...state.disabledKinds, ...featureDisabled])]
      }
    `,
  ],
  [
    'mock:features',
    `
      const state = globalThis[Symbol.for('openbooks.search-permission-test')]
      export async function isFeatureEnabled(_orgId, feature) {
        state.featureChecks.push(feature)
        return state.features[feature] ?? true
      }
      // subsidiaries.ts (loaded for real, so its shared subsidiary-visible
      // filter stays under test) only needs this UI-visibility flag.
      export function subsidiaryFeatureEnabled() {
        return true
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    const mockUrl = new Map([
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['./authz', 'mock:authz'],
      ['./documents', 'mock:documents'],
      ['./features', 'mock:features'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const searchUrl = './search.ts?permission-regression'
const { globalSearch } = await import(searchUrl) as typeof import('./search.ts')
hooks.deregister()

function authz(...permissions: string[]): Parameters<typeof globalSearch>[0] {
  return {
    user: { orgId: 'org-1' },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as unknown as Parameters<typeof globalSearch>[0]
}

function scopedAuthz(
  allowedSubsidiaryIds: readonly string[],
  ...permissions: string[]
): Parameters<typeof globalSearch>[0] {
  return {
    ...authz(...permissions),
    allowedSubsidiaryIds: new Set(allowedSubsidiaryIds),
  }
}

function reset({
  disabledKinds = [],
  documents = [...BASE_DOCUMENTS, UNMAPPED_DOCUMENT],
  features = {},
}: {
  disabledKinds?: string[]
  documents?: SearchFixture[]
  features?: Record<string, boolean>
} = {}): void {
  state.disabledKinds = disabledKinds
  state.documents = documents
  state.featureChecks.length = 0
  state.features = { banking: true, fieldTickets: true, projects: true, ...features }
  state.kindFeatures = { ...DOC_KIND_FEATURE } as Record<string, string>
  state.queries.length = 0
}

function transactionHits(response: Awaited<ReturnType<typeof globalSearch>>) {
  return response.groups.find((group) => group.type === 'transaction')?.hits ?? []
}

function transactionHitIds(response: Awaited<ReturnType<typeof globalSearch>>): string[] {
  return transactionHits(response).map((hit) => hit.id)
}

function transactionQuery(): CapturedQuery {
  const matches = state.queries.filter((query) => query.text.includes('with cand as'))
  assert.equal(matches.length, 1, 'global search must issue exactly one transaction query')
  return matches[0]!
}

function boundKinds(query: CapturedQuery): string[] {
  const known = new Set(state.documents.map((row) => row.kind))
  return [...new Set(query.values.filter((value): value is string => (
    typeof value === 'string' && known.has(value)
  )))]
}

function fixture(kind: string): SearchFixture {
  const row = BASE_DOCUMENTS.find((candidate) => candidate.kind === kind)
  assert.ok(row, `missing registry-derived fixture for ${kind}`)
  return row
}

function kindsForPermission(permission: string): string[] {
  return TRANSACTION_KINDS.filter((kind) => transactionModule(kind)?.requiredPermission === permission)
}

function nativeHref(kind: string): string {
  const href = moduleDrawerHref(kind, kind, {
    projectId: kind === 'project_charge' ? PROJECT_ID : null,
  })
  assert.ok(href, `missing native href for ${kind}`)
  return href
}

test('fixtures derive from the runtime transaction registry and every kind has an authorized native destination', () => {
  assert.deepEqual(BASE_DOCUMENTS.map((row) => row.kind), [...TRANSACTION_KINDS])
  for (const kind of TRANSACTION_KINDS) {
    const moduleKey = TRANSACTION_MODULE_BY_KIND[kind]
    const module = MODULE_BY_KEY.get(moduleKey)
    assert.ok(module, `${kind}: missing ${moduleKey}`)
    assert.ok(module.requiredPermission, `${kind}: native module must authorize reads`)
    assert.ok(module.recordTarget, `${kind}: native module must address records`)
    const domainFeature = DOC_KIND_FEATURE[kind]
    if (domainFeature) assert.equal(module.featureKey, domainFeature, `${kind}: domain feature drift`)

    const url = new URL(nativeHref(kind), 'https://openbooks.example')
    assert.ok(
      url.pathname === module.href || url.pathname.startsWith(`${module.href}/`),
      `${kind}: ${url.pathname} must stay inside ${module.href}`,
    )
    if (kind !== 'journal') assert.notEqual(url.pathname, '/journal', `${kind}: no GL fallback`)
  }
})

test('search follows shared navigation policy and metadata instead of a private copy', async () => {
  const module = MODULE_BY_KEY.get(TRANSACTION_MODULE_BY_KIND.vendor_payment)
  assert.ok(module)
  const original = {
    href: module.href,
    label: module.label,
    iconKey: module.iconKey,
    requiredPermission: module.requiredPermission,
  }

  Object.assign(module, {
    href: '/mutated-vendor-payments',
    label: 'Mutated Vendor Payments',
    iconKey: 'activity',
    requiredPermission: 'ar.pay',
  })
  try {
    reset({ documents: [fixture('vendor_payment')] })
    const stalePermission = await globalSearch(authz('ap.pay'), 'needle')
    assert.deepEqual(transactionHitIds(stalePermission), [])
    assert.equal(state.queries.filter((query) => query.text.includes('with cand as')).length, 0)

    reset({ documents: [fixture('vendor_payment')] })
    const sharedPermission = await globalSearch(authz('ar.pay'), 'needle')
    const hit = transactionHits(sharedPermission)[0]
    assert.equal(hit?.id, 'vendor_payment')
    assert.equal(hit?.href, '/mutated-vendor-payments?payment=vendor_payment')
    assert.equal(hit?.title, 'Mutated Vendor Payments VENDOR_PAYMENT')
    assert.equal(hit?.iconKey, 'activity')
  } finally {
    Object.assign(module, original)
  }
})

test('each transaction module permission exposes only its own document kinds', async () => {
  for (const permission of TRANSACTION_PERMISSIONS) {
    const expectedKinds = kindsForPermission(permission)
    reset()
    const response = await globalSearch(authz(permission), 'needle')
    assert.deepEqual(transactionHitIds(response), expectedKinds, permission)

    const query = transactionQuery()
    assert.deepEqual(boundKinds(query), expectedKinds, `${permission}: SQL kind allowlist`)
    assert.equal(
      query.text.match(/d\.kind in/g)?.length,
      3,
      `${permission}: both candidate legs and the final read must be permission-filtered`,
    )
  }
})

test('AP and AR documents open the list-owned native drawers, never cockpit routes', async () => {
  reset()
  const apHits = transactionHits(await globalSearch(authz('ap.read'), 'needle'))
  const apByKind = Object.fromEntries(apHits.map((hit) => [hit.id, hit.href]))
  for (const kind of ['vendor_bill', 'vendor_credit'] as const) {
    assert.equal(apByKind[kind], `/ap/bills?doc=${kind}`)
    assert.doesNotMatch(apByKind[kind]!, /^\/ap\?doc=/)
  }

  reset()
  const arHits = transactionHits(await globalSearch(authz('ar.read'), 'needle'))
  const arByKind = Object.fromEntries(arHits.map((hit) => [hit.id, hit.href]))
  for (const kind of ['customer_invoice', 'customer_credit'] as const) {
    assert.equal(arByKind[kind], `/ar/invoices?doc=${kind}`)
    assert.doesNotMatch(arByKind[kind]!, /^\/ar\?doc=/)
  }
})

test('mixed and wildcard permissions compose with a native destination for every production kind', async () => {
  reset()
  const mixed = await globalSearch(authz('ap.read', 'ar.pay'), 'needle')
  assert.deepEqual(transactionHitIds(mixed), [
    ...kindsForPermission('ap.read'),
    ...kindsForPermission('ar.pay'),
  ])

  reset()
  const superAdmin = await globalSearch(authz('*'), 'needle')
  assert.deepEqual(transactionHitIds(superAdmin), [...TRANSACTION_KINDS])
  assert.ok(!transactionHitIds(superAdmin).includes('unmapped_document'))
  for (const hit of transactionHits(superAdmin)) {
    const module = transactionModule(hit.id)
    assert.ok(module)
    assert.equal(hit.href, nativeHref(hit.id))
    assert.equal(hit.iconKey, module.iconKey)
    assert.ok(hit.title.startsWith(`${module.label} `))
  }
})

test('numeric amount candidates carry the same permission allowlist as text candidates', async () => {
  reset()
  const response = await globalSearch(authz('ap.read'), '12.34')
  const expectedKinds = kindsForPermission('ap.read')
  assert.deepEqual(transactionHitIds(response), expectedKinds)

  const query = transactionQuery()
  assert.equal(
    query.text.match(/d\.kind in/g)?.length,
    4,
    'text, party, amount, and final result legs must all be permission-filtered',
  )
  for (const kind of expectedKinds) {
    assert.equal(query.values.filter((value) => value === kind).length, 4, kind)
  }
})

test('feature-disabled document kinds remain hidden inside an allowed module', async () => {
  reset({ disabledKinds: ['pay_run'] })
  const response = await globalSearch(authz('gl.read', 'payroll.read'), 'needle')
  assert.deepEqual(transactionHitIds(response), kindsForPermission('gl.read'))
  assert.deepEqual(boundKinds(transactionQuery()), kindsForPermission('gl.read'))
})

test('field tickets require time access and their feature before linking to the native drawer', async () => {
  reset({ features: { fieldTickets: false } })
  const disabled = await globalSearch(authz('time.read'), 'needle')
  assert.deepEqual(transactionHitIds(disabled), [])
  assert.equal(state.queries.filter((query) => query.text.includes('with cand as')).length, 0)

  reset()
  const enabled = await globalSearch(authz('time.read'), 'needle')
  assert.deepEqual(transactionHitIds(enabled), ['field_ticket'])
  assert.equal(transactionHits(enabled)[0]?.href, '/field-tickets?ticket=field_ticket')

  reset()
  const denied = await globalSearch(authz('projects.read'), 'needle')
  assert.ok(!transactionHitIds(denied).includes('field_ticket'))
})

test('banking-off suppresses only Banking search results through navigation visibility', async () => {
  const bankingKinds = kindsForPermission('banking.read')
  reset({ features: { banking: false } })
  const mixed = await globalSearch(authz('banking.read', 'ap.read'), 'needle')
  assert.deepEqual(transactionHitIds(mixed), kindsForPermission('ap.read'))
  assert.deepEqual(boundKinds(transactionQuery()), kindsForPermission('ap.read'))
  assert.ok(state.featureChecks.includes('banking'))

  reset({ features: { banking: false } })
  const bankingOnly = await globalSearch(authz('banking.read'), 'needle')
  assert.deepEqual(transactionHitIds(bankingOnly), [])
  assert.equal(state.queries.filter((query) => query.text.includes('with cand as')).length, 0)
  assert.ok(state.featureChecks.includes('banking'))

  reset()
  const enabled = await globalSearch(authz('banking.read'), 'needle')
  assert.deepEqual(transactionHitIds(enabled), bankingKinds)
  assert.deepEqual(
    transactionHits(enabled).map((hit) => hit.href),
    bankingKinds.map(nativeHref),
  )
})

test('vendor payments and customer receipts keep separate permissions, destinations, and secrets', async () => {
  reset()
  const apResponse = await globalSearch(authz('ap.pay'), 'needle')
  const apHits = transactionHits(apResponse)
  assert.deepEqual(apHits.map((hit) => hit.id), ['vendor_payment'])
  assert.equal(apHits[0]?.href, '/payments?payment=vendor_payment')
  assert.equal(apHits[0]?.subtitle, fixture('vendor_payment').party_name)
  assert.equal(apHits[0]?.amount, '701.11')
  const apPayload = JSON.stringify(apResponse)
  assert.ok(!apPayload.includes(fixture('customer_payment').memo))
  assert.ok(!apPayload.includes('902.22'))

  reset()
  const arResponse = await globalSearch(authz('ar.pay'), 'needle')
  const arHits = transactionHits(arResponse)
  assert.deepEqual(arHits.map((hit) => hit.id), ['customer_payment'])
  assert.equal(arHits[0]?.href, '/receipts?payment=customer_payment')
  assert.equal(arHits[0]?.subtitle, fixture('customer_payment').memo)
  assert.equal(arHits[0]?.amount, '902.22')
  const arPayload = JSON.stringify(arResponse)
  assert.ok(!arPayload.includes(String(fixture('vendor_payment').party_name)))
  assert.ok(!arPayload.includes('701.11'))
})

test('subsidiary restrictions fence documents before sensitive fields are returned', async () => {
  const deniedDocument: SearchFixture = {
    ...fixture('vendor_bill'),
    id: 'vendor_bill-denied-subsidiary',
    document_number: 'DENIED-SUBSIDIARY',
    memo: 'denied-subsidiary:memo:confidential',
    party_name: 'denied-subsidiary:counterparty:confidential',
    amount: '987654.32',
    subsidiary_id: DENIED_SUBSIDIARY,
  }
  reset({ documents: [...BASE_DOCUMENTS, UNMAPPED_DOCUMENT, deniedDocument] })

  const response = await globalSearch(scopedAuthz([ALLOWED_SUBSIDIARY], 'ap.read'), 'needle')
  assert.deepEqual(transactionHitIds(response), kindsForPermission('ap.read'))
  const payload = JSON.stringify(response)
  assert.ok(!payload.includes(deniedDocument.memo))
  assert.ok(!payload.includes(String(deniedDocument.party_name)))
  assert.ok(!payload.includes(Number(deniedDocument.amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })))

  const query = transactionQuery()
  assert.equal(
    query.text.match(/d\.subsidiary_id = any/g)?.length,
    3,
    'both text candidates and the final sensitive-field read must be subsidiary scoped',
  )
  assert.ok(query.values.includes(`{${ALLOWED_SUBSIDIARY}}`))

  reset({ documents: [deniedDocument] })
  const noSubsidiaries = await globalSearch(scopedAuthz([], 'ap.read'), 'needle')
  assert.deepEqual(transactionHitIds(noSubsidiaries), [])
  assert.match(transactionQuery().text, /and false/)
})

test('subsidiary-aware contacts, accounts, and projects use their canonical scope semantics', async () => {
  reset()
  await globalSearch(
    scopedAuthz([ALLOWED_SUBSIDIARY], 'parties.read', 'gl.read', 'projects.read'),
    'needle',
  )

  const contacts = state.queries.find((query) => query.text.includes('select p.id, p.display_name'))
  const accounts = state.queries.find((query) => query.text.includes('select id, number, name, type from accounts'))
  const projects = state.queries.find((query) => query.text.includes('select id, code, name from projects'))
  assert.ok(contacts)
  assert.ok(accounts)
  assert.ok(projects)
  assert.match(contacts.text, /p\.subsidiary_id is null or p\.subsidiary_id = any/)
  assert.match(accounts.text, /subsidiary_id is null or subsidiary_id = any/)
  assert.match(projects.text, /subsidiary_id = any/)
  assert.doesNotMatch(projects.text, /subsidiary_id is null/)
})
