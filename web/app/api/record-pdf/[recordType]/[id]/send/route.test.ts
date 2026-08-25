import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PDF_RECORD_TYPES } from '../../../../../../lib/pdf-templates/catalog'
import { PERMISSION_CATALOGUE, permissionSetCovers } from '../../../../../../lib/permissions'

// Route boundary suite for outbound PDF email (the same harness as
// /api/payments/[id]): the REAL route handler runs against scripted gates and
// a spied sender. It pins the send-side authorization contract — emailing a
// record to any recipient is a write-side act that read access alone must
// never authorize — and proves a denial leaves no delivery or email_log
// trace because the sender is unreachable behind the gate.

const stateKey = Symbol.for('openbooks.record-pdf-send-route-test')
interface SendRouteState {
  granted: Set<string>
  recipientCalls: { recordType: string; orgId: string; id: string }[]
  sendCalls: Record<string, unknown>[]
  recipient: { to: string | null; docTitle: string; reference: string; partyName: string | null } | null
}
const state: SendRouteState = {
  granted: new Set(),
  recipientCalls: [],
  sendCalls: [],
  recipient: { to: 'party@acme.test', docTitle: 'Invoice', reference: 'INV-000001', partyName: 'Acme Construction Inc.' },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'authz',
    `
      const state = globalThis[Symbol.for('openbooks.record-pdf-send-route-test')]
      import { NextResponse } from 'next/server'
      export async function guardPermission(perm) {
        if (!state.granted.has('*') && !state.granted.has(perm)) {
          return NextResponse.json({ error: \`missing permission: \${perm}\` }, { status: 403 })
        }
        return { user: { id: 'user-1', orgId: 'org-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
      }
      export function can(_authz, perm) {
        return state.granted.has('*') || state.granted.has(perm)
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  [
    'documents',
    `
      export async function isDocKindEnabled() { return true }
    `,
  ],
  [
    'send',
    `
      const state = globalThis[Symbol.for('openbooks.record-pdf-send-route-test')]
      export async function resolveRecordRecipient(recordType, orgId, id) {
        state.recipientCalls.push({ recordType, orgId, id })
        return state.recipient
      }
      export async function sendRecordPdfEmail(args) {
        state.sendCalls.push(args)
        return { to: args.to ?? state.recipient?.to ?? '', subject: 'Test subject' }
      }
    `,
  ],
  [
    'record-scope',
    `
      export async function loadRecordSubsidiaryScope() { return { subsidiaryId: null } }
    `,
  ],
  [
    // Same JSON boundary semantics as lib/api/json.ts (object passes through,
    // anything else fails closed as 400) so the route exercises its real shape.
    'json',
    `
      import { NextResponse } from 'next/server'
      export const jsonObject = {}
      export async function parseJsonBody(req) {
        const raw = await req.json().catch(() => undefined)
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          return { ok: false, response: NextResponse.json({ error: 'invalid request body' }, { status: 400 }) }
        }
        return { ok: true, data: raw }
      }
    `,
  ],
])

// Mock modules live behind query-string variants of THIS file's own URL: a
// real file: base under web/ so bare imports inside the mocks (next/server)
// still resolve through the workspace, while the load hook swaps the source.
const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', mockUrl('json')],
  ['../../../../../../lib/authz', mockUrl('authz')],
  ['../../../../../../lib/documents', mockUrl('documents')],
  ['../../../../../../lib/pdf-templates/send', mockUrl('send')],
  ['../../../lib', mockUrl('record-scope')],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    if (parsed.search.startsWith('?mock=')) {
      const source = mockSources.get(parsed.searchParams.get('mock') ?? '')
      if (source !== undefined) {
        return { format: 'module', source, shortCircuit: true }
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?record-pdf-send-test'
const { GET, POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.granted = new Set()
  state.recipientCalls = []
  state.sendCalls = []
}

function post(recordType: string, body?: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/record-pdf/${recordType}/00000000-0000-4000-8000-00000000a001/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
    { params: Promise.resolve({ recordType, id: '00000000-0000-4000-8000-00000000a001' }) },
  )
}

test('read-only access cannot authorize an outbound send for any record type', async () => {
  for (const meta of PDF_RECORD_TYPES) {
    reset()
    state.granted = new Set([meta.readPermission])

    const response = await post(meta.key, { to: 'someone@elsewhere.test' })

    assert.equal(response.status, 403, `${meta.key}: ${meta.readPermission} alone must not send`)
    const payload = (await response.json()) as { error: string }
    assert.match(payload.error, /^missing permission: /, `${meta.key}: denial names the missing authority`)
    assert.deepEqual(state.sendCalls, [], `${meta.key}: a denied send never reaches delivery or email_log`)
    assert.deepEqual(state.recipientCalls, [], `${meta.key}: denial settles before any disclosure work`)
  }
})

test('every record type demands a catalogue-listed authority its read permission does not cover', async () => {
  // Harvest each type's demanded authority from the route itself (no mirrored
  // map in this test), then pin its canonicality.
  for (const meta of PDF_RECORD_TYPES) {
    reset()
    state.granted = new Set([meta.readPermission])
    const response = await post(meta.key)
    const payload = (await response.json()) as { error: string }
    const permission = payload.error.replace('missing permission: ', '')
    assert.ok(
      (PERMISSION_CATALOGUE as readonly string[]).includes(permission),
      `${meta.key}: send authority "${permission}" must be a seeded, role-assignable catalogue key`,
    )
    assert.equal(
      permissionSetCovers(new Set([meta.readPermission]), permission),
      false,
      `${meta.key}: read access (${meta.readPermission}) alone must never cover the send authority`,
    )
  }
})

test('an authorized sender reaches delivery exactly once with the validated recipient', async () => {
  reset()
  state.granted = new Set(['ar.read', 'ar.create'])

  const response = await post('customer_invoice', { to: '  cfo@buyer.test  ', message: 'Attached invoice' })

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { ok: boolean; to: string }
  assert.equal(payload.ok, true)
  assert.equal(payload.to, 'cfo@buyer.test', 'the recipient is trimmed at the boundary')
  assert.equal(state.sendCalls.length, 1)
  assert.deepEqual(state.sendCalls[0], {
    recordType: 'customer_invoice',
    orgId: 'org-1',
    id: '00000000-0000-4000-8000-00000000a001',
    to: 'cfo@buyer.test',
    message: 'Attached invoice',
    templateId: null,
  })
})

test('a blank recipient falls through to the party email on file inside the sender', async () => {
  reset()
  state.granted = new Set(['ar.read', 'ar.create'])

  const response = await post('customer_invoice')

  assert.equal(response.status, 200)
  assert.equal(state.sendCalls.length, 1)
  assert.equal((state.sendCalls[0] as Record<string, unknown>).to, undefined, 'no explicit recipient is forwarded')
})

test('a malformed explicit recipient is refused before any delivery work', async () => {
  reset()
  state.granted = new Set(['ar.read', 'ar.create'])

  for (const bad of ['not-an-email', 'two@ats@example.test@again', 'spaces in@example.test']) {
    const response = await post('customer_invoice', { to: bad })
    assert.equal(response.status, 400, `"${bad}" must be refused at the boundary`)
    assert.deepEqual(state.sendCalls, [], `"${bad}" must never reach the sender`)
  }
})

test('GET keeps rendering/recipient prefill on read authority alone', async () => {
  reset()
  state.granted = new Set(['ar.read'])

  const response = await GET(
    new Request('http://openbooks.test/api/record-pdf/customer_invoice/00000000-0000-4000-8000-00000000a001/send'),
    { params: Promise.resolve({ recordType: 'customer_invoice', id: '00000000-0000-4000-8000-00000000a001' }) },
  )

  assert.equal(response.status, 200, 'read access still prefills the send dialog')
  assert.equal(state.recipientCalls.length, 1)
  assert.deepEqual(state.sendCalls, [], 'GET never delivers mail')
})
