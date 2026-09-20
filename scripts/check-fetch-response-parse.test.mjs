import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { auditRepository, loadAllowlist, reconcile } from './check-fetch-response-parse.mjs'

/**
 * The guard exists because three client saves in one day parsed the response
 * body BEFORE checking the status, so a non-JSON error body threw a
 * SyntaxError out of res.json() and the operator never saw the server's
 * refusal. These tests pin the guard in both directions: realistic violation
 * shapes must flag with an identifying location, and every sanctioned shape
 * must stay clean — a guard that flags everything gates nothing, and a guard
 * that flags nothing protects nothing.
 *
 * Sources are fed as text to the real audit function (never a doubled
 * parser): what is asserted here is what the build runs.
 */

function auditOne(path, source) {
  const { violations, syntaxErrors } = auditRepository([path], () => source)
  assert.deepEqual(syntaxErrors, [], `the snippet must parse cleanly: ${path}`)
  return violations
}

// The profile-tab load shape: body parsed, status asked afterwards.
const PROFILE_LOAD_SHAPE = `
export function PayrollProfileTab({ partyId }: { partyId: string }) {
  const loadProfile = async () => {
    const res = await fetch('/api/payroll/profiles?employee=' + partyId)
    const payload = (await res.json()) as { country?: string; error?: string }
    if (!res.ok) throw new Error(payload.error ?? 'failed to load the payroll profile')
    return payload
  }
  return loadProfile
}
`

// The certificate-save shape: error extracted from a body that may not parse.
const CERTIFICATE_SAVE_SHAPE = `
export function CertificateForm({ partyId }: { partyId: string }) {
  async function saveCertificate(answers: Record<string, string>) {
    const certRes = await fetch('/api/payroll/certificates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee: partyId, answers }),
    })
    const body = (await certRes.json()) as { error?: string }
    if (!certRes.ok) throw new Error(body.error ?? 'failed to save the certificate')
  }
  return saveCertificate
}
`

// The run-wizard chain shape: the check runs in a downstream continuation,
// so it executes AFTER the parse, not before it.
const RUN_WIZARD_CHAIN_SHAPE = `
export function commitRun(runId: string) {
  return fetch('/api/payroll/runs/' + runId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'post' }),
  }).then((runRes) =>
    runRes.json().then((j) => {
      if (!runRes.ok) {
        throw new Error(j.error ?? 'failed to post the pay run')
      }
      return j
    }),
  )
}
`

test('flags the profile-load shape: parse before the status check', () => {
  const violations = auditOne('web/app/(app)/payroll/_ui/PayrollProfileTab.tsx', PROFILE_LOAD_SHAPE)
  assert.equal(violations.length, 1, 'one parse-before-check site must flag exactly once')
  assert.equal(violations[0].path, 'web/app/(app)/payroll/_ui/PayrollProfileTab.tsx')
  assert.equal(violations[0].fn, 'loadProfile', 'the violation must name the owning operation, not the file')
  assert.equal(typeof violations[0].line, 'number')
  assert.ok(violations[0].line > 0, 'the violation must carry the line so the message identifies the site')
})

test('flags the certificate-save shape: error read off a maybe-unparseable body', () => {
  const violations = auditOne(
    'web/app/(app)/payroll/_ui/PackCertificateForms.tsx',
    CERTIFICATE_SAVE_SHAPE,
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].fn, 'saveCertificate')
})

test('flags the chained shape: a downstream continuation check runs after the parse', () => {
  const violations = auditOne('web/app/(app)/payroll/runs/[id]/RunWizard.tsx', RUN_WIZARD_CHAIN_SHAPE)
  assert.equal(
    violations.length,
    1,
    'a status check in a downstream .then() executes after the parse, so it guards nothing',
  )
  assert.equal(violations[0].fn, 'commitRun')
})

test('flags a status read that merely toasts and falls through', () => {
  const violations = auditOne(
    'web/app/(app)/sync/PlatformClient.tsx',
    `
export function SyncPanel() {
  async function reload() {
    const res = await fetch('/api/platform/connections')
    if (!res.ok) {
      console.error('load failed with status ' + res.status)
    }
    const payload = await res.json()
    return payload
  }
  return reload
}
`,
  )
  assert.equal(
    violations.length,
    1,
    'a check whose branch neither throws nor returns lets the parse run on the failure path',
  )
})

test('does not flag a compound guard that still routes every failure out', () => {
  const violations = auditOne(
    'web/components/assistant/assistant-app.tsx',
    `
export function AssistantApp() {
  async function refreshConversations(activeId: string, cancelled: boolean) {
    const res = await fetch('/api/assistant/conversations/' + activeId)
    if (!res.ok || cancelled) return
    const body = (await res.json()) as { messages: string[] }
    void body
  }
  return refreshConversations
}
`,
  )
  assert.deepEqual(violations, [])
})

test('does not flag a parse nested in the success branch of a compound check', () => {
  const violations = auditOne(
    'web/components/assistant/assistant-app.tsx',
    `
export function AssistantApp() {
  async function adoptConversation(conversationId: string, cancelled: boolean) {
    const t = await fetch('/api/assistant/conversations/' + conversationId)
    if (t.ok && !cancelled) {
      const adopted = ((await t.json()) as { messages: string[] }).messages
      void adopted
    }
  }
  return adoptConversation
}
`,
  )
  assert.deepEqual(violations, [])
})

test('flags a conjunctive guard that lets failures fall through', () => {
  const violations = auditOne(
    'web/app/(app)/sync/PlatformClient.tsx',
    `
export function SyncPanel() {
  async function reload(retryable: boolean) {
    const res = await fetch('/api/platform/connections')
    if (!res.ok && retryable) throw new Error('load failed')
    const payload = await res.json()
    return payload
  }
  return reload
}
`,
  )
  assert.equal(
    violations.length,
    1,
    'a failure without retry rights falls past the throw straight into the parse',
  )
})

test('does not flag res.json().catch(...): the parse cannot throw', () => {
  const violations = auditOne(
    'web/app/(app)/payroll/runs/[id]/RunWizard.tsx',
    `
export function downloadCheques(documentId: string) {
  return fetch('/api/payroll/runs/' + documentId + '/cheques-pdf', { method: 'POST' }).then(
    async (res) => {
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'failed to build the cheques file')
      }
      return res.blob()
    },
  )
}
`,
  )
  assert.deepEqual(violations, [])
})

test('does not flag a status guard before the parse', () => {
  const violations = auditOne(
    'web/app/(app)/payroll/_ui/EmployeesPanel.tsx',
    `
import { readApiErrorMessage } from '../../../../lib/api-error'
export function ProfileEditor({ partyId }: { partyId: string }) {
  async function saveProfile(isActive: boolean) {
    const res = await fetch('/api/payroll/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee: partyId, isActive }),
    })
    if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to save the payroll profile'))
    const saved = (await res.json()) as { id: string }
    return saved
  }
  return saveProfile
}
`,
  )
  assert.deepEqual(violations, [])
})

test('does not flag the sanctioned helper itself', () => {
  // The convention file parses inside readApiErrorMessage; the audit runs
  // against the real file so a rewrite of the helper that reintroduces
  // parse-before-check is measured here too. The helper takes a bare
  // Response parameter — never fetch-assigned — so its parse is out of scope.
  const { violations } = auditRepository(['web/lib/api-error.ts'])
  assert.deepEqual(violations, [])
})

test('does not flag server-side request parsing', () => {
  const violations = auditOne(
    'web/app/api/payroll/settings/route.ts',
    `
import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  const body = (await req.json()) as { action?: string }
  if (body.action !== 'install-pack') return NextResponse.json({ error: 'unknown action' }, { status: 400 })
  return NextResponse.json({ ok: true })
}
`,
  )
  assert.deepEqual(violations, [], 'req.json() parses the request, not a fetch Response')
})

test('does not flag the guarded-parse helper shape', () => {
  // The local fetchJson/postJson choke points convert the SyntaxError to a
  // null body at the parse site and return the status for the CALLER to
  // check — the same contract readApiErrorMessage offers. Their try block
  // checks no status and their catch does not rethrow.
  const violations = auditOne(
    'web/app/(app)/admin/setup/allocations/RuleDrawer.tsx',
    `
async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}
export { fetchJson }
`,
  )
  assert.deepEqual(violations, [])
})

test('does not flag a success-path parse the flow never status-checks', () => {
  // Boundary, pinned deliberately: with no status read anywhere in the flow
  // the checker cannot tell a checked parse from an assumed one, so it stays
  // silent. Extending the guard to unchecked parses is a conscious scope
  // change — this test forces it to be one.
  const violations = auditOne(
    'web/app/(app)/insights/CardTile.tsx',
    `
export function CardTile({ id }: { id: string }) {
  async function loadCard() {
    const res = await fetch('/api/insights/cards/' + id)
    const card = (await res.json()) as { title: string }
    return card.title
  }
  return loadCard
}
`,
  )
  assert.deepEqual(violations, [])
})

test('a broken file reports a syntax error, never a clean pass', () => {
  const { violations, syntaxErrors } = auditRepository(['web/app/(app)/Broken.tsx'], () => `export async function broken() {\n  const res = await fetch('/api/broken')\n  const j = await res.json(;\n  if (!res.ok) throw new Error('broken')\n}`)
  assert.deepEqual(violations, [])
  assert.deepEqual(syntaxErrors, ['web/app/(app)/Broken.tsx'])
})

test('the allow-list exempts a listed site and keeps its reason', () => {
  const violations = auditOne('web/app/(app)/payroll/_ui/PayrollProfileTab.tsx', PROFILE_LOAD_SHAPE)
  assert.equal(violations.length, 1)
  const { knownGaps, newViolations, staleEntries } = reconcile(violations, [
    {
      path: 'web/app/(app)/payroll/_ui/PayrollProfileTab.tsx',
      fn: 'loadProfile',
      reason: 'test-only entry',
    },
  ])
  assert.equal(newViolations.length, 0)
  assert.equal(staleEntries.length, 0)
  assert.equal(knownGaps.length, 1)
  assert.equal(knownGaps[0].reason, 'test-only entry')
})

test('a fixed site fails as a stale allow-list entry, not a silent pass', () => {
  const { knownGaps, newViolations, staleEntries } = reconcile([], [
    {
      path: 'web/app/(app)/payroll/_ui/PayrollProfileTab.tsx',
      fn: 'loadProfile',
      reason: 'test-only entry',
    },
  ])
  assert.deepEqual(knownGaps, [])
  assert.deepEqual(newViolations, [])
  assert.deepEqual(
    staleEntries.map((entry) => `${entry.path}::${entry.fn}`),
    ['web/app/(app)/payroll/_ui/PayrollProfileTab.tsx::loadProfile'],
  )
})

test('an allow-list entry without a reviewed reason is rejected', () => {
  assert.throws(
    () => loadAllowlist(() => JSON.stringify([{ path: 'a.tsx', fn: 'f', reason: '  ' }])),
    /no reviewed reason/,
  )
  assert.throws(
    () => loadAllowlist(() => JSON.stringify([{ path: 'a.tsx', fn: 'f' }])),
    /no reviewed reason/,
  )
})
