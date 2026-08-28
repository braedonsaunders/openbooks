import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const routeSource = readFileSync(join(webRoot, 'app/api/analytics/drill/route.ts'), 'utf8')
const stateKey = Symbol.for('openbooks.analytics-drill-decimal-test')
const routeState = { responses: [] as Array<{ rows: unknown[] }> }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  ['mock:authz', 'export async function guardPermission() { return { user: { id: \'test\', orgId: \'test\' } } }'],
  [
    'mock:db',
    `const state = globalThis[Symbol.for('openbooks.analytics-drill-decimal-test')]
     export const db = { execute: async () => state.responses.shift() ?? { rows: [] } }`,
  ],
  ['mock:drizzle', 'export function sql(strings, ...values) { return { strings, values } }'],
  [
    'mock:next-server',
    `export class NextResponse extends Response {
       static json(value, init) {
         return new NextResponse(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
       }
     }`,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      '../../../../lib/authz': 'mock:authz',
      '@openbooks/engine/src/db.ts': 'mock:db',
      'drizzle-orm': 'mock:drizzle',
      'next/server': 'mock:next-server',
    }
    const url = mocks[specifier]
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    return source === undefined
      ? nextLoad(url, context)
      : { format: 'module', shortCircuit: true, source }
  },
})

const { GET, serializeLedgerDecimal } = await import('../app/api/analytics/drill/route.ts?analytics-drill-decimal-test')
hooks.deregister()

test('analytics drill keeps high-precision and unsafe-size decimals exact', () => {
  const highPrecision = '9007199254740993.1234'
  assert.equal(serializeLedgerDecimal(highPrecision), highPrecision)
  assert.equal(serializeLedgerDecimal(9007199254740993n), '9007199254740993')
  assert.equal(serializeLedgerDecimal('1.2345'), '1.2345')
  assert.throws(() => serializeLedgerDecimal(Number(9007199254740993n)), /must not be JavaScript numbers/)
})

test('analytics drill preserves signs and canonical zero', () => {
  assert.equal(serializeLedgerDecimal('-9007199254740993.1234'), '-9007199254740993.1234')
  assert.equal(serializeLedgerDecimal('-0.0000'), '0')
  assert.equal(serializeLedgerDecimal('0000.0000'), '0')
  assert.equal(serializeLedgerDecimal(null), '0')
})

test('analytics drill GET serializes account and party amounts without numeric coercion', async () => {
  routeState.responses = [
    { rows: [{ date: '2026-01-01', entry_id: 'entry-1', doc_id: null, doc_kind: null, doc_number: null, party_name: '', memo: '', amount: '-9007199254740993.1234' }] },
    { rows: [{ month: '2026-01', amount: '0.0001' }] },
    { rows: [{ name: 'No party', amount: '9007199254740993.1234', n: '1' }] },
    { rows: [{ total: '9007199254740993.1234', n: '1' }] },
  ]
  const accountResponse = await GET(new Request('https://books.example.test/api/analytics/drill?account=account-1&from=2026-01-01&to=2026-01-31'))
  const account = await accountResponse.json() as { total: string; entries: { amount: string }[]; monthly: { amount: string }[]; breakdown: { amount: string }[] }
  assert.equal(account.total, '9007199254740993.1234')
  assert.equal(account.entries[0]?.amount, '-9007199254740993.1234')
  assert.equal(account.monthly[0]?.amount, '0.0001')
  assert.equal(account.breakdown[0]?.amount, '9007199254740993.1234')

  routeState.responses = [
    { rows: [{ date: '2026-01-01', entry_id: null, doc_id: 'doc-1', doc_kind: 'invoice', doc_number: 'INV-1', status: 'posted', memo: '', amount: '9007199254740993.1234' }] },
    { rows: [{ month: '2026-01', amount: '1.2345' }] },
    { rows: [{ name: 'invoice', amount: '1.2345', n: '1' }] },
    { rows: [{ total: '1.2345', n: '1' }] },
  ]
  const partyResponse = await GET(new Request('https://books.example.test/api/analytics/drill?party=party-1&from=2026-01-01&to=2026-01-31'))
  const party = await partyResponse.json() as { total: string; entries: { amount: string }[]; monthly: { amount: string }[]; breakdown: { amount: string }[] }
  assert.equal(party.total, '1.2345')
  assert.equal(party.entries[0]?.amount, '9007199254740993.1234')
  assert.equal(party.monthly[0]?.amount, '1.2345')
  assert.equal(party.breakdown[0]?.amount, '1.2345')
})

test('account and party monetary projections all use decimal serialization', () => {
  for (const projection of [
    'total: serializeLedgerDecimal(agg.rows[0]?.total)',
    'amount: serializeLedgerDecimal(r.amount)',
    'amount: serializeLedgerDecimal(r.amount), count: Number(r.n)',
  ]) {
    assert.ok(routeSource.includes(projection), `missing decimal projection: ${projection}`)
  }
  assert.doesNotMatch(routeSource, /(?:total|amount): Number\(/)
  assert.doesNotMatch(routeSource, /Number\(r\.amount\)/)
})
