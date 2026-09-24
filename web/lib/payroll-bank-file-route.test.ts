import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'

/**
 * Bank-file boundary: generating a file moves money, so POST demands
 * payroll.run (the GET panel needs only payroll.read); every response is
 * marked no-store; and POST returns artifact metadata as JSON — the bytes
 * live behind the sibling [fileId] route, where release is audited.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const PROFILE = '22222222-2222-4222-8222-222222222222'

const bankKey = Symbol.for('openbooks.bank-file-route-test')
const bankState: { granted: Set<string>; generated: unknown[]; errorToThrow: unknown } = {
  granted: new Set(),
  generated: [],
  errorToThrow: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[bankKey] = bankState

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksBankFileSqlText = sqlText

const dbUrl = import.meta.resolve('@openbooks/engine/src/platform/db.ts')

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.bank-file-route-test')]
      export async function guardFeaturePermission(permission) {
        if (!state.granted.has(permission)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        return { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:authz',
    'export function guardSubsidiaryScope() { return null }',
  ],
  [
    'mock:db',
    `
      export * from '${dbUrl}'
      const state = globalThis[Symbol.for('openbooks.bank-file-route-test')]
      const sqlText = globalThis.openbooksBankFileSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('from pay_runs r')) return { rows: [{ subsidiaryId: null }] }
          throw new Error('bank-file paths must not issue SQL: ' + text.slice(0, 120))
        },
      }
    `,
  ],
  [
    'mock:bank-file',
    `
      export const PAYROLL_BANK_FILE_FORMATS = { EFT: { enabled: true, currency: 'CAD' } }
      export async function payRunBankFilePopulation() { return { rail: 'EFT', members: [] } }
      export async function payrollBankProfiles() { return [] }
    `,
  ],
  [
    'mock:bank-file-artifact',
    `
      const state = globalThis[Symbol.for('openbooks.bank-file-route-test')]
      export async function generatePayRunBankFile(input) {
        state.generated.push(input)
        if (state.errorToThrow) throw state.errorToThrow
        return { fileId: 'file-1', byteCount: 120 }
      }
      export async function listPayRunBankFiles() { return [] }
      export async function payRunBankFileAudit() { return [] }
      export async function payRunBankFileEntitlement() {
        return { entitled: true, runStatus: 'committed' }
      }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../../../lib/feature-gates', mockUrl('feature-gates')],
  ['../../../../../../lib/authz', mockUrl('authz')],
  ['@openbooks/engine/src/platform/db.ts', mockUrl('db')],
  ['@openbooks/engine/src/payroll/bank-file.ts', mockUrl('bank-file')],
  ['@openbooks/engine/src/payroll/bank-file-artifact.ts', mockUrl('bank-file-artifact')],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations() { return (key) => key }',
      }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    const name = parsed.searchParams.get('mock')
    const source = name ? mockSources.get(`mock:${name}`) : undefined
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const bankFileUrl = '../app/api/payroll/runs/[id]/bank-file/route.ts?bank-file-route'
const { GET, POST } = (await import(bankFileUrl)) as typeof import('../app/api/payroll/runs/[id]/bank-file/route.ts')
hooks.deregister()

const NO_STORE = 'no-store'

function asReader() {
  bankState.granted = new Set(['payroll.read'])
  bankState.generated = []
  bankState.errorToThrow = null
}

function asRunner() {
  bankState.granted = new Set(['payroll.read', 'payroll.run'])
  bankState.generated = []
  bankState.errorToThrow = null
}

test('generating a bank file demands run authority; the panel needs only read', async () => {
  asReader()
  const denied = await POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}/bank-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentBankProfileId: PROFILE }),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  assert.equal(denied.status, 403)
  assert.deepEqual(bankState.generated, [], 'no file may be generated for a read-only caller')

  const panel = await GET(new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}/bank-file`), {
    params: Promise.resolve({ id: RUN_ID }),
  })
  assert.equal(panel.status, 200)
})

test('bank-file responses are never cached', async () => {
  asRunner()
  const panel = await GET(new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}/bank-file`), {
    params: Promise.resolve({ id: RUN_ID }),
  })
  assert.equal(panel.headers.get('cache-control'), NO_STORE)

  const generated = await POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}/bank-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentBankProfileId: PROFILE }),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  assert.equal(generated.headers.get('cache-control'), NO_STORE)

  bankState.errorToThrow = new PayrollError('run is not committed')
  const refused = await POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}/bank-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentBankProfileId: PROFILE }),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  bankState.errorToThrow = null
  assert.equal(refused.status, 409)
  assert.equal(refused.headers.get('cache-control'), NO_STORE)
})

test('generate returns artifact metadata as JSON, never bytes', async () => {
  asRunner()
  const response = await POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}/bank-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paymentBankProfileId: PROFILE }),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await response.json(), { artifact: { fileId: 'file-1', byteCount: 120 } })
  assert.deepEqual(bankState.generated, [{
    orgId: 'org-1',
    documentId: RUN_ID,
    actorId: 'user-1',
    paymentBankProfileId: PROFILE,
    supersedeReason: null,
    allowedSubsidiaryIds: null,
  }])
})
