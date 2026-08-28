import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Regression coverage for direct document email delivery attribution: every
// email_log row a direct send produces must name its sender in audit evidence.
// An interactive delivery attributes the canonical created_by column to the
// signed-in user; anything outside an interactive session records EXPLICIT
// system provenance (meta.actorKind + meta.actorReason) instead of leaving an
// anonymous row. The engine's insertEmailLog runs unmocked here against a
// captured database, so the assertions cover the actual INSERT statement —
// columns, parameter order, and the attribution evidence itself.

interface CapturedInsert {
  columns: string[]
  values: unknown[]
  text: string
}

const USER_ID = '018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70'

const state = {
  /** Simulated Next.js request scope: controls whether cookies() works. */
  requestScope: false,
  /** Signed-in principal resolved by getAuthz, or null. */
  currentUser: null as { id: string } | null,
  inserts: [] as CapturedInsert[],
  updates: [] as Array<{ text: string; values: unknown[] }>,
  deliveries: [] as Array<{ to: string; subject: string }>,
  sendError: null as Error | null,
  sendOutcome: null as { kind: 'uncertain'; reason: string } | null,
  uncertaintyWriteError: null as Error | null,
  uncertaintyWriteAmbiguous: false,
}

const harness = {
  state,
  async execute(query: { text?: string; values?: unknown[] }) {
    const text = String(query.text ?? '')
    if (text.includes('insert into email_log')) {
      const columns = text
        .match(/insert into email_log \(([^)]*)\)/)?.[1]
        ?.split(',')
        .map((column) => column.trim()) ?? []
      state.inserts.push({ columns, values: query.values ?? [], text })
      return { rows: [{ id: `log-${state.inserts.length}` }] }
    }
    if (text.includes('update email_log')) {
      state.updates.push({ text, values: query.values ?? [] })
      if (text.includes("status = 'uncertain'")) {
        if (state.uncertaintyWriteError) throw state.uncertaintyWriteError
        // The SQL reached the database, but the caller cannot learn whether
        // it committed. This models the same ambiguous result as a lost
        // response after the uncertainty transition was applied.
        if (state.uncertaintyWriteAmbiguous) throw new Error('uncertainty write commit status unknown')
      }
      return { rows: [] }
    }
    // readOrgEmailConfig: no stored provider config; the mocked transport
    // package resolves one regardless so the send pipeline proceeds.
    if (text.includes('from orgs') && text.includes('settings')) {
      return { rows: [{ email: null }] }
    }
    throw new Error(`unexpected query in attribution test: ${text}`)
  },
}

;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.pdf-send-attribution-test')] = harness

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
  [
    'mock:db',
    `
      const harness = globalThis[Symbol.for('openbooks.pdf-send-attribution-test')]
      export const db = { execute: (query) => harness.execute(query) }
      export async function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    'mock:emails',
    `
      const harness = globalThis[Symbol.for('openbooks.pdf-send-attribution-test')]

      export function documentEmail(input) {
        return { subject: \`Document \${input.reference}\`, html: '<p>doc</p>', text: 'doc' }
      }

      export async function resolveEmailTransport() {
        return { provider: 'test' }
      }

      export async function sendVia(transport, message, identity) {
        if (harness.state.sendError) throw harness.state.sendError
        harness.state.deliveries.push({ to: message.to, subject: message.subject })
        if (harness.state.sendOutcome) return harness.state.sendOutcome
        return { kind: 'sent', providerMessageId: 'provider-message-1' }
      }

      export function deriveEmailDeliveryKey() {
        return \`obem_\${'a'.repeat(40)}\`
      }

      export function sealSecret(secret) {
        return { ciphertext: \`sealed:\${secret}\`, nonce: 'nonce' }
      }

      export function validateStoredEmailConfig(config) {}
    `,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-08-25' }`,
  ],
  [
    'mock:email-tokens',
    `export function appBaseUrl() { return 'https://openbooks.example' }`,
  ],
  [
    'mock:openbooks-pdf',
    `export async function verifyPdfEncryption() {}`,
  ],
  [
    'mock:features',
    `export async function isFeatureEnabled() { return false }`,
  ],
  [
    'mock:authz',
    `
      const harness = globalThis[Symbol.for('openbooks.pdf-send-attribution-test')]
      export async function getAuthz() {
        return harness.state.currentUser ? { user: { ...harness.state.currentUser } } : null
      }
    `,
  ],
  [
    'mock:next-headers',
    `
      const harness = globalThis[Symbol.for('openbooks.pdf-send-attribution-test')]
      export async function cookies() {
        if (!harness.state.requestScope) {
          throw new Error('cookies was called outside a request scope')
        }
        return { get: () => undefined }
      }
    `,
  ],
  [
    'mock:render',
    `
      const harness = globalThis[Symbol.for('openbooks.pdf-send-attribution-test')]
      export async function mergeAndPrintPdf() {
        return Buffer.from('%PDF-1.4 rendered')
      }
    `,
  ],
  [
    'mock:store',
    `export async function resolvePdfTemplate() { return { id: 'template-1' } }`,
  ],
  [
    'mock:values',
    `
      export async function loadPdfRecordValues(recordType, orgId, id) {
        return {
          values: {
            party_email: 'party@example.test',
            party_name: 'Example Party',
            org_name: 'Example Org',
          },
          reference: 'INV-0001',
          recordId: id,
        }
      }
    `,
  ],
])

registerHooks({  resolve(specifier, context, nextResolve) {
    // The real email-config module under test imports its db sibling
    // relatively; share the same mocked engine db instance.
    if (specifier === './db.ts' && context.parentURL?.includes('/engine/src/email-config.ts')) {
      return { url: 'mock:db', shortCircuit: true }
    }
    const mocks: Record<string, string> = {
      'server-only': 'mock:server-only',
      'drizzle-orm': 'mock:drizzle-orm',
      '@openbooks/engine/src/db.ts': 'mock:db',
      '@openbooks/emails': 'mock:emails',
      '@openbooks/engine/src/business-date.ts': 'mock:business-date',
      '@openbooks/engine/src/flows/email-tokens.ts': 'mock:email-tokens',
      '@openbooks/pdf': 'mock:openbooks-pdf',
      '../features': 'mock:features',
      '../authz': 'mock:authz',
      'next/headers': 'mock:next-headers',
      './render': 'mock:render',
      './store': 'mock:store',
      './values': 'mock:values',
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

// The hooks intentionally stay registered for this whole file: send.ts
// resolves the web auth graph lazily AT SEND TIME (only inside a live request
// scope), so those runtime imports must still land on the mocks above. Test
// files run one process each, so nothing leaks across suites.

// Imported through the same specifier graph the production route uses; the
// email-config module is deliberately NOT mocked so the assertions exercise
// the real INSERT statement it builds.
// The cache-buster keeps this module instance distinct from any other suite's
// while the hooks above route its dependencies to the mocks.
const sendModuleUrl = './send.ts?attribution-test'
const { sendRecordPdfEmail } = await import(sendModuleUrl) as typeof import('./send.ts')
const { insertEmailLog } = await import('../../../engine/src/email-config.ts')

function reset(): void {
  state.requestScope = false
  state.currentUser = null
  state.inserts.length = 0
  state.updates.length = 0
  state.deliveries.length = 0
  state.sendError = null
  state.sendOutcome = null
  state.uncertaintyWriteError = null
  state.uncertaintyWriteAmbiguous = false
}

/** Map an INSERT's column list onto its bound parameter values. */
function loggedRow(insert: CapturedInsert): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  insert.columns.forEach((column, index) => {
    row[column] = insert.values[index]
  })
  return row
}

function lastMeta(): Record<string, unknown> {
  const insert = state.inserts.at(-1)
  assert.ok(insert, 'expected an email_log insert to be recorded')
  const row = loggedRow(insert)
  return JSON.parse(String(row.meta)) as Record<string, unknown>
}

test('an interactive direct delivery is attributed to the sending user in the canonical audit column', async () => {
  reset()
  state.requestScope = true
  state.currentUser = { id: USER_ID }

  const result = await sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' })

  assert.equal(result.to, 'party@example.test')
  assert.equal(state.deliveries.length, 1)

  const insert = state.inserts.at(-1)!
  assert.ok(insert.columns.includes('created_by'), 'the INSERT must write created_by')
  const row = loggedRow(insert)
  assert.equal(row.created_by, USER_ID)
  assert.deepEqual(JSON.parse(String(row.recipients)), ['party@example.test'])

  const meta = lastMeta()
  assert.equal(meta.actorKind, 'user')
  assert.equal('actorReason' in meta, false, 'a user-attributed row carries no system reason')
  assert.equal(meta.recordType, 'customer_invoice')
  assert.equal(meta.recordId, 'inv-1')

  assert.match(state.updates.at(-1)!.text, /status = 'sent'/)
})

test('a sessionless delivery records explicit system provenance instead of an anonymous row', async () => {
  reset()

  const result = await sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' })

  assert.equal(result.to, 'party@example.test')
  // Explicit provenance is recorded, and the delivery still happens — the
  // row must never silently look like "nobody recorded who sent this".
  assert.equal(state.deliveries.length, 1)

  const row = loggedRow(state.inserts.at(-1)!)
  assert.equal(row.created_by, null)
  const meta = lastMeta()
  assert.equal(meta.actorKind, 'system')
  assert.equal(typeof meta.actorReason, 'string')
  assert.ok((meta.actorReason as string).length > 0)
})

test('a signed-out request is likewise attributed as explicit system provenance', async () => {
  reset()
  state.requestScope = true

  await sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' })

  const row = loggedRow(state.inserts.at(-1)!)
  assert.equal(row.created_by, null)
  const meta = lastMeta()
  assert.equal(meta.actorKind, 'system')
  assert.ok((meta.actorReason as string).length > 0)
})

test('a failed provider send still carries attribution on the failed row', async () => {
  reset()
  state.requestScope = true
  state.currentUser = { id: USER_ID }
  state.sendError = new Error('smtp down')

  await assert.rejects(
    () => sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' }),
    /smtp down/,
  )

  const row = loggedRow(state.inserts.at(-1)!)
  assert.equal(row.created_by, USER_ID)
  const failure = state.updates.find((update) => update.text.includes("status = 'failed'"))
  assert.ok(failure, 'the failed send must be marked failed')
  assert.equal(failure.values[0], 'smtp down')
})

test('an uncertain provider outcome remains uncertain instead of being overwritten as failed', async () => {
  reset()
  state.sendOutcome = { kind: 'uncertain', reason: 'provider acceptance could not be confirmed' }

  await assert.rejects(
    () => sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' }),
    /provider acceptance could not be confirmed/,
  )

  assert.equal(state.deliveries.length, 1)
  const uncertain = state.updates.filter((update) => update.text.includes("status = 'uncertain'"))
  assert.equal(uncertain.length, 1, 'the unresolved send must be parked as uncertain')
  assert.equal(
    state.updates.some((update) => update.text.includes("status = 'failed'")),
    false,
    'an uncertainty error must not trigger a failed transition',
  )
  assert.equal(uncertain[0]!.values[0], 'provider acceptance could not be confirmed')
})

test('an uncertainty persistence error is not relabelled as a failed delivery', async () => {
  reset()
  state.sendOutcome = { kind: 'uncertain', reason: 'provider acceptance could not be confirmed' }
  state.uncertaintyWriteError = new Error('uncertainty write failed')

  await assert.rejects(
    () => sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' }),
    /uncertainty write failed/,
  )

  assert.equal(
    state.updates.some((update) => update.text.includes("status = 'failed'")),
    false,
    'an uncertainty persistence error must not trigger a failed transition',
  )
})

test('an ambiguous uncertainty commit is not relabelled as a failed delivery', async () => {
  reset()
  state.sendOutcome = { kind: 'uncertain', reason: 'provider acceptance could not be confirmed' }
  state.uncertaintyWriteAmbiguous = true

  await assert.rejects(
    () => sendRecordPdfEmail({ recordType: 'customer_invoice', orgId: 'org-1', id: 'inv-1' }),
    /uncertainty write commit status unknown/,
  )

  assert.equal(
    state.updates.filter((update) => update.text.includes("status = 'uncertain'")).length,
    1,
    'the uncertainty transition was attempted once before its commit became ambiguous',
  )
  assert.equal(
    state.updates.some((update) => update.text.includes("status = 'failed'")),
    false,
    'an ambiguous uncertainty commit must not trigger a failed transition',
  )
})

test('caller-supplied meta cannot forge or strip the attribution markers', async () => {
  reset()
  state.requestScope = true

  await insertEmailLog({
    orgId: 'org-1',
    recipients: ['auditor@example.test'],
    subject: 'spoof attempt: user',
    status: 'queued',
    categoryKey: 'document',
    meta: { actorKind: 'system', actorReason: 'forged' },
    actor: { kind: 'user', userId: USER_ID },
  })
  let row = loggedRow(state.inserts.at(-1)!)
  assert.equal(row.created_by, USER_ID)
  let meta = JSON.parse(String(row.meta)) as Record<string, unknown>
  assert.equal(meta.actorKind, 'user')
  assert.equal('actorReason' in meta, false)

  await insertEmailLog({
    orgId: 'org-1',
    recipients: ['auditor@example.test'],
    subject: 'spoof attempt: system',
    status: 'queued',
    categoryKey: 'document',
    meta: { actorKind: 'user' },
    actor: { kind: 'system', reason: 'nightly batch' },
  })
  row = loggedRow(state.inserts.at(-1)!)
  assert.equal(row.created_by, null)
  meta = JSON.parse(String(row.meta)) as Record<string, unknown>
  assert.equal(meta.actorKind, 'system')
  assert.equal(meta.actorReason, 'nightly batch')
})

test('an empty user attribution fails closed instead of writing a blank audit column', async () => {
  reset()
  state.requestScope = true
  const insertsBefore = state.inserts.length

  await assert.rejects(
    () =>
      insertEmailLog({
        orgId: 'org-1',
        recipients: ['auditor@example.test'],
        subject: 'blank actor',
        status: 'queued',
        actor: { kind: 'user', userId: '   ' },
      }),
    /non-empty/,
  )
  assert.equal(state.inserts.length, insertsBefore)
})
