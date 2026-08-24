import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { renderPasswordExpression } from '../../packages/pdf/src/password-expression.ts'
import { PDF_RECORD_TYPE_BY_KEY } from './pdf-templates/catalog.ts'

// Regression coverage for the payroll attachment ciphertext contract: a
// compensation PDF may only leave as verified ciphertext, and the batch
// sender must supply per-employee encryption or fail the employee. The
// dependency graph of the sender is served by mocks through module hooks;
// certification itself is delegated to the real qpdf-backed verifier, so a
// forged encryption marker cannot pass here any more than in production.

interface StubRow {
  id: string
  name: string
  email: string | null
  delivery: 'email' | 'print' | 'both'
  employee_number: string | null
  birth_date: string | null
}

interface SendCall {
  recordType: string
  orgId: string
  id: string
  encrypt?: (pdf: Buffer) => Promise<Buffer>
}

interface SqlQuery {
  text: string
  values: unknown[]
}

// Fixed one-page fixtures keep the sender test hermetic. The encrypted
// fixture is genuine AES-256 ciphertext (non-empty user password, produced by
// qpdf); neither fixture contains payroll data.
const plainPdfFixture = Buffer.from(
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgKHB5cGRmKQo+PgplbmRvYmoKMiAwIG9iago8PAovVHlwZSAvUGFnZXMKL0NvdW50IDEKL0tpZHMgWyA0IDAgUiBdCj4+CmVuZG9iagozIDAgb2JqCjw8Ci9UeXBlIC9DYXRhbG9nCi9QYWdlcyAyIDAgUgo+PgplbmRvYmoKNCAwIG9iago8PAovVHlwZSAvUGFnZQovUmVzb3VyY2VzIDw8Cj4+Ci9NZWRpYUJveCBbIDAuMCAwLjAgNzIgNzIgXQovUGFyZW50IDIgMCBSCj4+CmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTEzIDAwMDAwIG4gCjAwMDAwMDAxNjIgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA1Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCj4+CnN0YXJ0eHJlZgoyNTQKJSVFT0YK',
  'base64',
)
const encryptedPdfFixture = Buffer.from(
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDU4MDY2NWJkNmIxMjA4OTcyYWMxZjgyNjFjODQxMzVhZWI2NzVmYmUxMWFjNzg3OGVkMjRhOTZlYTRmOTI4ZjE+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViA1Ci9SIDYKL0xlbmd0aCAyNTYKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8NTc5MDY5MjNiMjNmOGQyOGMzYzVhZjcwOWQyNzVhMWY5Y2ZmMGZiYmY4NzM2MDcwNTY3NzA3ZWFhMDM2OTQzMzAzNTlhOWRmNjBjOGFkNGIzNDcwYjliZDQwMDE4ZjUwYT4KL1UgPGVjYmYxYjM3OGNjMjEyM2M2ZTE5NmJjYjdhMTkxODgwOGYzZWFhOGE3M2M0NDIyYmQyZjcyOWI5NGZiNjA5YjYyMGFjOTM1ZTEzYzU2NjkyZmNkZmY4MWM4NGI0MDIwPgovQ0YgPDwKL1N0ZENGIDw8Ci9BdXRoRXZlbnQgL0RvY09wZW4KL0NGTSAvQUVTVjMKL0xlbmd0aCAzMgo+Pgo+PgovU3RtRiAvU3RkQ0YKL1N0ckYgL1N0ZENGCi9PRSA8NjY3YmRkNTVjMTY5OTJiYTIwOWE4MjI4MjY5ZjdhNTg0MTJmMTg4YmM0YTk2MWVmMjVmNmM5ZTlkOWUxOTAxNz4KL1VFIDwwZjM2MjIwZmM1ODdjNzVjNDkwNjExZDI5MWYxZWFlNmRjYzhmMmRlMzg2OGJiZjNkYmRmMWM0MTJhYzI4MzJmPgovUGVybXMgPDhjODEwODdkZjE1MzRjZmIzZGZlMzUxODE0ZWFjZTM5Pgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMTMgMDAwMDAgbiAKMDAwMDAwMDE3MiAwMDAwMCBuIAowMDAwMDAwMjIxIDAwMDAwIG4gCjAwMDAwMDAzMTUgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjY2MzU2MTY2NjE2NTY2MzEzMTMxPiA8MzUzOTYzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjY2MzU2MTY2NjE2NTY2MzEzMT4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKODcwCiUlRU9GCg==',
  'base64',
)

const stateKey = Symbol.for('openbooks.payroll-outputs-test')
const state = {
  stubs: [] as StubRow[],
  policy: { enabled: false, expression: '' } as { enabled?: unknown; expression?: unknown },
  sendCalls: [] as SendCall[],
  deliveryCalls: [] as Array<{ to: string; attachment: Buffer }>,
  recordEmail: 'employee@example.test',
  templateResolveCalls: 0,
  recordLoadCalls: 0,
  transportResolveCalls: 0,
  encryptionPasswords: [] as string[],
  encryptionError: null as Error | null,
  renderedPdf: plainPdfFixture,
  encryptedFixture: encryptedPdfFixture.toString('base64'),
}

const harness = {
  state,
  // The mocked @openbooks/pdf delegates certification to the real qpdf-backed
  // verifier, imported lazily at call time (after the hooks deregister).
  pdfCryptoModuleUrl: new URL('../../packages/pdf/src/encrypt.ts', import.meta.url).href,
  async execute(query: SqlQuery) {
    if (query.text.includes('from pay_stubs s')) return { rows: state.stubs }
    if (query.text.includes("settings#>'{payroll,stubPassword}'")) {
      return { rows: [{ policy: state.policy }] }
    }
    throw new Error(`unexpected payroll output query: ${query.text}`)
  },
  renderPasswordExpression,
}

;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = harness

const mockSources = new Map<string, string>([
  ['mock:server-only', 'export {}'],
  [
    'mock:drizzle-orm',
    `
      export function sql(strings, ...values) {
        return { text: strings.join('?'), values }
      }
    `,
  ],
  // Only encryptPdf itself is stubbed (returning genuine encrypted bytes);
  // certification delegates to the real qpdf-backed verifier, so the send
  // path runs against real ciphertext AND the independent check guarding it.
  [
    'mock:openbooks-pdf',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]

      export async function encryptPdf(pdf, options) {
        harness.state.encryptionPasswords.push(options.userPassword)
        if (harness.state.encryptionError) throw harness.state.encryptionError
        return Buffer.from(harness.state.encryptedFixture, 'base64')
      }

      export async function verifyPdfEncryption(pdf) {
        const crypto = await import(harness.pdfCryptoModuleUrl)
        return crypto.verifyPdfEncryption(pdf)
      }

      export function renderPasswordExpression(expression, catalog, values) {
        return harness.renderPasswordExpression(expression, catalog, values)
      }
    `,
  ],
  [
    'mock:db',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]
      export const db = { execute: (query) => harness.execute(query) }
    `,
  ],
  [
    'mock:payroll-cheques',
    `
      export async function issuePayRunCheques() {
        throw new Error('cheque output is outside this test')
      }
    `,
  ],
  [
    'mock:render',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]
      export async function mergeAndPrintPdf() {
        return Buffer.from(harness.state.renderedPdf)
      }
    `,
  ],
  [
    'mock:store',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]
      export async function resolvePdfTemplate() {
        harness.state.templateResolveCalls += 1
        return { id: 'template-1' }
      }
    `,
  ],
  [
    'mock:values',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]

      export async function loadPdfRecordValues() {
        harness.state.recordLoadCalls += 1
        return {
          values: {
            party_email: harness.state.recordEmail,
            party_name: 'Jordan Sparks',
            org_name: 'Example Org',
          },
          reference: 'PAY-0001 Jordan Sparks',
        }
      }
    `,
  ],
  [
    'mock:emails',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]

      export function documentEmail() {
        return { subject: 'Payroll document', html: '<p>Payroll document</p>', text: 'Payroll document' }
      }

      export async function sendVia(_transport, message) {
        harness.state.deliveryCalls.push({
          to: message.to,
          attachment: Buffer.from(message.attachments[0].content, 'base64'),
        })
        return { id: 'provider-message-1' }
      }
    `,
  ],
  [
    'mock:email-config',
    `
      const harness = globalThis[Symbol.for('openbooks.payroll-outputs-test')]
      export async function resolveOrgEmailTransport() {
        harness.state.transportResolveCalls += 1
        return { provider: 'test' }
      }
      export async function insertEmailLog() { return 'email-log-1' }
      export async function markEmailSent() {}
      export async function markEmailFailed() {}
    `,
  ],
  ['mock:business-date', `export async function businessToday() { return '2026-08-24' }`],
  ['mock:email-tokens', `export function appBaseUrl() { return 'https://openbooks.example' }`],
  ['mock:features', `export async function isFeatureEnabled() { return false }`],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      'server-only': 'mock:server-only',
      'drizzle-orm': 'mock:drizzle-orm',
      '@openbooks/pdf': 'mock:openbooks-pdf',
      '@openbooks/engine/src/db.ts': 'mock:db',
      '@openbooks/engine/src/payroll-cheques.ts': 'mock:payroll-cheques',
      '@openbooks/emails': 'mock:emails',
      '@openbooks/engine/src/email-config.ts': 'mock:email-config',
      '@openbooks/engine/src/business-date.ts': 'mock:business-date',
      '@openbooks/engine/src/flows/email-tokens.ts': 'mock:email-tokens',
      './pdf-templates/render': 'mock:render',
      './pdf-templates/store': 'mock:store',
      './pdf-templates/values': 'mock:values',
      './render': 'mock:render',
      './store': 'mock:store',
      './values': 'mock:values',
      '../features': 'mock:features',
    }
    const url = mocks[specifier]
    if (url) return { url, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const payrollOutputsUrl = './payroll-outputs.ts?payroll-ciphertext-test'
const { emailRunStubs } = await import(payrollOutputsUrl) as typeof import('./payroll-outputs.ts')
const protectedSenderUrl = './pdf-templates/send.ts?payroll-ciphertext-test'
const {
  isProtectedPayrollRecordType,
  sendRecordPdfEmail,
} = await import(protectedSenderUrl) as typeof import('./pdf-templates/send.ts')
hooks.deregister()

function reset(stubs: StubRow[], policy: { enabled: boolean; expression: string }): void {
  state.stubs = stubs
  state.policy = policy
  state.sendCalls.length = 0
  state.deliveryCalls.length = 0
  state.recordEmail = 'employee@example.test'
  state.templateResolveCalls = 0
  state.recordLoadCalls = 0
  state.transportResolveCalls = 0
  state.encryptionPasswords.length = 0
  state.encryptionError = null
  state.renderedPdf = plainPdfFixture
  state.encryptedFixture = encryptedPdfFixture.toString('base64')
}

const protectedPayrollRecordTypes = Object.values(PDF_RECORD_TYPE_BY_KEY)
  .filter((meta) => meta.readPermission === 'payroll.read')
  .map((meta) => meta.key)
  .sort()

const stub = (overrides: Partial<StubRow> = {}): StubRow => ({
  id: 'stub-1',
  name: 'Jordan Sparks',
  email: 'jordan@example.test',
  delivery: 'email',
  employee_number: 'EMP-42',
  birth_date: '1990-02-03',
  ...overrides,
})

test('the catalog-derived protection class covers every compensation PDF alias', () => {
  assert.ok(protectedPayrollRecordTypes.includes('pay_stub'))
  assert.ok(protectedPayrollRecordTypes.includes('payroll_cheque'))
  for (const recordType of protectedPayrollRecordTypes) {
    assert.equal(isProtectedPayrollRecordType(recordType), true, `${recordType} must be protected`)
  }
  assert.equal(isProtectedPayrollRecordType('customer_invoice'), false)
})

test('a protected payroll PDF cannot be sent without a protection pass', async () => {
  reset([], { enabled: true, expression: '{surname:3|upper}' })
  for (const recordType of protectedPayrollRecordTypes) {
    await assert.rejects(
      () => sendRecordPdfEmail({ recordType, orgId: 'org-1', id: 'stub-1' }),
      /payroll compensation PDFs must be encrypted before email delivery/,
    )
  }
  // Refused before any dependency work: nothing was rendered or loaded.
  assert.equal(state.templateResolveCalls, 0)
  assert.equal(state.recordLoadCalls, 0)
  assert.equal(state.transportResolveCalls, 0)
  assert.equal(state.deliveryCalls.length, 0)
})

test('verified ciphertext is what actually reaches the transport', async () => {
  reset([], { enabled: true, expression: '{surname:3|upper}' })
  for (const recordType of protectedPayrollRecordTypes) {
    let encryptionCalls = 0
    await sendRecordPdfEmail({
      recordType,
      orgId: 'org-1',
      id: 'stub-1',
      encrypt: async (pdf) => {
        encryptionCalls += 1
        assert.deepEqual(pdf, plainPdfFixture)
        return Buffer.from(encryptedPdfFixture)
      },
    })
    const delivery = state.deliveryCalls.at(-1)
    assert.equal(delivery?.to, 'employee@example.test')
    assert.deepEqual(delivery?.attachment, encryptedPdfFixture)
    assert.notDeepEqual(delivery?.attachment, plainPdfFixture)
    assert.equal(encryptionCalls, 1)
  }
  assert.equal(state.deliveryCalls.length, protectedPayrollRecordTypes.length)
})

test('identity, copied, alternate-plaintext, unencrypted, and malformed outputs are all refused', async () => {
  reset([], { enabled: true, expression: '{surname:3|upper}' })
  const plaintextEncryptors: Array<[string, (pdf: Buffer) => Promise<Buffer>]> = [
    ['identity', async (pdf) => pdf],
    ['copied plaintext', async (pdf) => Buffer.from(pdf)],
    ['changed plaintext', async (pdf) => Buffer.concat([pdf, Buffer.from('\n')])],
    ['unencrypted PDF', async () => Buffer.from(plainPdfFixture)],
    ['malformed bytes', async () => Buffer.from('this is not a pdf')],
  ]

  for (const recordType of protectedPayrollRecordTypes) {
    for (const [kind, encrypt] of plaintextEncryptors) {
      await assert.rejects(
        () => sendRecordPdfEmail({ recordType, orgId: 'org-1', id: 'stub-1', encrypt }),
        /payroll compensation PDF encryption must return a valid encrypted PDF/,
        `${recordType} accepted ${kind}`,
      )
    }
  }
  assert.equal(state.deliveryCalls.length, 0)
})

test('a forged encryption marker cannot smuggle plaintext past the sender', async () => {
  reset([], { enabled: true, expression: '{surname:3|upper}' })
  // A plaintext file whose trailer carries an /Encrypt entry: lenient parsers
  // report it as encrypted while every viewer reads the payload without a
  // password — exactly what the old parser-flag check accepted.
  const doc = await PDFDocument.load(plainPdfFixture)
  doc.context.trailerInfo.Encrypt = doc.context.register(
    doc.context.obj({
      Filter: 'Standard', V: 5, R: 6, Length: 256,
      O: '00', U: '00', OE: '00', UE: '00', P: -1, Perms: '00',
    }),
  )
  const forged = Buffer.from(await doc.save())
  await assert.rejects(() => PDFDocument.load(forged), /encrypted/)

  for (const recordType of protectedPayrollRecordTypes) {
    await assert.rejects(
      () => sendRecordPdfEmail({
        recordType,
        orgId: 'org-1',
        id: 'stub-1',
        encrypt: async () => Buffer.from(forged),
      }),
      /payroll compensation PDF encryption must return a valid encrypted PDF/,
      `${recordType} accepted a forged encryption marker`,
    )
  }
  assert.equal(state.deliveryCalls.length, 0)
})

test('an ordinary record still emails without encryption', async () => {
  reset([], { enabled: true, expression: '{surname:3|upper}' })
  await sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'invoice-1' })
  assert.equal(state.deliveryCalls.length, 1)
  assert.deepEqual(state.deliveryCalls[0]?.attachment, plainPdfFixture)
})

test('a disabled password policy delivers no eligible pay stubs', async () => {
  reset([
    stub({ id: 'print', name: 'Print Only', delivery: 'print' }),
    stub({ id: 'missing', name: 'No Email', email: null }),
    stub({ id: 'email', name: 'Email Employee' }),
    stub({ id: 'both', name: 'Both Employee', delivery: 'both' }),
  ], {
    enabled: false,
    // A stale saved expression must not turn a disabled policy into consent.
    expression: '{surname:3|upper}{dob:MMDDYYYY}',
  })

  const result = await emailRunStubs('org-1', 'run-1')

  assert.deepEqual(result, {
    sent: 0,
    noEmail: ['No Email'],
    printOnly: ['Print Only'],
    failed: [
      { name: 'Email Employee', error: 'pay-stub email delivery requires an enabled password policy' },
      { name: 'Both Employee', error: 'pay-stub email delivery requires an enabled password policy' },
    ],
  })
  assert.equal(state.deliveryCalls.length, 0)
  assert.equal(state.encryptionPasswords.length, 0)
})

test('every eligible delivery is encrypted with the employee-derived password', async () => {
  reset([stub()], { enabled: true, expression: '{surname:3|upper}{dob:MMDDYYYY}' })

  const result = await emailRunStubs('org-1', 'run-1')

  assert.deepEqual(result, { sent: 1, noEmail: [], printOnly: [], failed: [] })
  assert.equal(state.deliveryCalls.length, 1)
  assert.equal(state.deliveryCalls[0]?.to, 'employee@example.test')
  // The attachment that left is genuine ciphertext, not the rendered stub.
  assert.deepEqual(state.deliveryCalls[0]?.attachment, encryptedPdfFixture)
  assert.notDeepEqual(state.deliveryCalls[0]?.attachment, plainPdfFixture)
  assert.deepEqual(state.encryptionPasswords, ['SPA02031990'])
})

test('an encryption failure is recorded and never reported as a successful send', async () => {
  reset([stub()], { enabled: true, expression: '{employeeNumber|upper}' })
  state.encryptionError = new Error('qpdf unavailable')

  const result = await emailRunStubs('org-1', 'run-1')

  assert.equal(result.sent, 0)
  assert.deepEqual(result.failed, [{ name: 'Jordan Sparks', error: 'qpdf unavailable' }])
  assert.equal(state.deliveryCalls.length, 0)
  assert.deepEqual(state.encryptionPasswords, ['EMP42'])
})

const outputsSource = readFileSync(new URL('./payroll-outputs.ts', import.meta.url), 'utf8')

test('the batch sender has no plaintext policy branch', () => {
  assert.match(outputsSource, /if \(!policy\.enabled\)[\s\S]*result\.failed\.push/)
  assert.doesNotMatch(outputsSource, /\.\.\.\(policy\.enabled/)
  assert.match(outputsSource, /encrypt: async \(pdf: Buffer\) => encryptPdf/)
})
