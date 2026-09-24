import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Cutover contract for the provider/agents split: the AI provider page owns
 * provider credentials and document capture ONLY — pack configuration
 * (array, drawer, run-now) lives under Setup → Agents.
 *
 * The load-bearing assertion is the provider-save semantic: a PUT without an
 * `agents` array must leave every pack policy untouched. Before the split the
 * form always sent the full array, so normalizing an absent array to
 * all-packs-defaults was harmless; after the split the same default would
 * wipe all packs on every provider save. These tests drive the real PUT
 * route against a capturing database stand-in: omitting `agents` must issue
 * no `ai_agent_policies` statement, while sending the array persists it.
 */

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/ai',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {}
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

const root = pathToFileURL(process.cwd() + '/').href
const stateKey = Symbol.for('openbooks.ai-cutover-route')
const state: { statements: unknown[] } = { statements: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const { join } = await import('node:path')
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(root + 'web/' + specifier.slice(2) + '.ts', context)
    }
    if (specifier === '@openbooks/ui') {
      return { shortCircuit: true, url: worktreeUi }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts' || specifier.endsWith('/platform/db.ts')) {
      return { shortCircuit: true, format: 'module', url: 'mock:ai-cutover-db' }
    }
    if (specifier === '@/lib/authz' || specifier.endsWith('lib/authz') || specifier.endsWith('/authz')) {
      return { shortCircuit: true, format: 'module', url: 'mock:ai-cutover-authz' }
    }
    if (specifier === 'next/server') {
      return { shortCircuit: true, format: 'module', url: 'mock:ai-cutover-next' }
    }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, format: 'module', url: 'mock:ai-cutover-intl' }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return \'/admin/ai\'}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){const{children,...rest}=p;return globalThis.React.createElement(\'a\',rest,children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){}};export function Toaster(){return null}',
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:ai-cutover-db') {
      return {
        format: 'module',
        source: `
          const state = globalThis[Symbol.for('openbooks.ai-cutover-route')]
          // Every read returns one inert row: the upsert below reads the
          // RETURNING id into its audit write, so an empty row set would
          // throw inside the code under test instead of exercising it.
          // Select consumers all tolerate the junk row.
          const capture = async (query) => { state.statements.push(query); return { rows: [{ id: 'mock-row-1' }] } }
          const txShim = { execute: capture }
          export const db = {
            execute: capture,
            transaction: async (fn) => fn(txShim),
          }
          // Inert stand-ins for the rest of the platform-db surface: nothing
          // on this test's path calls them, but the engine modules under test
          // import them, so every name must exist.
          export const env = {}
          export const pool = null
          export const longPool = null
          export const orgContext = null
          export const schema = {}
          export function registerRequestOrgResolver() {}
          export function currentRequestOrgResolver() { return null }
          export function ambientTenantOrgId() { return null }
          export function ambientBypassWithoutTransaction() { return false }
          export async function assertSafeRuntimeDatabaseRole() {}
          export async function connectGovernedReadClient() { throw new Error('no database in this unit test') }
          export async function withMaintenanceTransaction(orgId, fn) { return fn() }
          export async function withOrg(orgId, fn) { return fn() }
          export async function withOrgTransaction(orgId, fn) { return fn() }
          export function withBypass(fn) { return fn() }
          export async function withBypassContext(fn) { return fn() }
          export async function withOrgContext(orgId, fn) { return fn() }
          export async function withTransactionSavepoint(runner, fn) { return fn() }
          export async function inDbTransaction(fn) { return fn(txShim) }
          export function runtimeDatabaseRoleCheckRequired() { return false }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:ai-cutover-authz') {
      return {
        format: 'module',
        source: `
          const authz = {
            user: { orgId: '00000000-0000-4000-8000-00000000a001', id: '00000000-0000-4000-8000-00000000a002' },
            permissions: new Set(['*']),
            allowedSubsidiaryIds: null,
          }
          export async function getAuthz() { return authz }
          export async function requirePermission() { return authz }
          export async function guardPermission() { return authz }
          export function can() { return false }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:ai-cutover-next') {
      return {
        format: 'module',
        source: `
          export class NextResponse extends Response {
            static json(body, init = {}) {
              return new Response(JSON.stringify(body), {
                ...init,
                headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
              })
            }
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:ai-cutover-intl') {
      return {
        format: 'module',
        source: 'export async function getTranslations() { return (key) => key }',
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

function collectStrings(node: unknown, out: string[]): void {
  if (node == null) return
  if (typeof node === 'string') {
    out.push(node)
    return
  }
  if (typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out)
    return
  }
  const record = node as Record<string, unknown>
  if (Array.isArray(record.queryChunks)) {
    collectStrings(record.queryChunks, out)
    return
  }
  if (typeof record.value === 'string') {
    out.push(record.value)
    return
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') collectStrings(value, out)
  }
}

function statementSql(statement: unknown): string {
  const texts: string[] = []
  collectStrings(statement, texts)
  return texts.join(' ')
}

/** A policy WRITE (insert/update/delete) — the post-save settings re-read
 *  selects the same table, which must not count as persisting policy. */
function writesAgentPolicies(): boolean {
  return state.statements
    .map(statementSql)
    .some((sql) => /ai_agent_policies/.test(sql) && /^\s*(insert|update|delete)\b/i.test(sql))
}

const { PUT } = await import('../../../../app/api/admin/ai/route')

async function putProvider(body: Record<string, unknown>): Promise<{ status: number }> {
  state.statements.length = 0
  const response = await PUT(
    new Request('http://cutover.test/api/admin/ai', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  await response.json().catch(() => null)
  return { status: response.status }
}

const PROVIDER_BODY = {
  enabled: true,
  provider: 'anthropic',
  modelFast: 'fast-1',
  modelSmart: 'smart-1',
  baseUrl: '',
}

test('a provider save that omits agents leaves every pack policy untouched', async () => {
  const { status } = await putProvider({ ...PROVIDER_BODY })
  assert.equal(status, 200)
  assert.ok(state.statements.length > 0, 'the provider save must still write its own settings')
  assert.equal(writesAgentPolicies(), false, 'omitting agents must not touch ai_agent_policies')
})

test('a provider save that sends agents persists the sent pack policies', async () => {
  const { status } = await putProvider({
    ...PROVIDER_BODY,
    agents: [{ agentKey: 'cash', enabled: false }],
  })
  assert.equal(status, 200)
  assert.equal(writesAgentPolicies(), true, 'sent agents must reach ai_agent_policies')
})

test('the provider form cross-links the Agents setup area', async () => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  Object.assign(globalThis, { React })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { NextIntlClientProvider } = await import('next-intl')
  const messages = (await import('../../../../messages/en')).default
  const { AiSettingsForm } = await import('./AiSettingsForm')

  document.body.innerHTML = ''
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  /* eslint-disable react/no-children-prop */
  await act(async () => {
    root.render(
      React.createElement(NextIntlClientProvider, {
        locale: 'en',
        messages,
        timeZone: 'UTC',
        children: React.createElement(AiSettingsForm, {
          specs: [
            {
              value: 'anthropic',
              label: 'Anthropic',
              baseUrl: null,
              requiresBaseUrl: false,
              fast: 'claude-haiku-4-5',
              smart: 'claude-sonnet-4-5',
              keyHint: '[REDACTED]',
            },
          ],
          initial: {
            enabled: true,
            provider: 'anthropic',
            modelFast: '',
            modelSmart: '',
            baseUrl: '',
            hasKey: false,
            documentCapture: {
              enabled: false,
              provider: 'azure_document_intelligence',
              endpoint: '',
              model: '',
              confidenceThreshold: '',
              autoCreatePoMatchedDrafts: false,
              hasKey: false,
            },
          },
        }),
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  /* eslint-enable react/no-children-prop */
  try {
    assert.ok(
      document.querySelector('a[href="/admin/setup/agents"]'),
      'the provider form must cross-link Setup → Agents, where pack configuration lives',
    )
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('the provider loader carries provider fields only — never agent policy', async () => {
  const { loadAdminAi } = await import('./view')
  const data = await loadAdminAi()
  assert.deepEqual(Object.keys(data.initial).sort(), [
    'baseUrl',
    'documentCapture',
    'enabled',
    'hasKey',
    'modelFast',
    'modelSmart',
    'provider',
  ])
  assert.ok(!('agents' in data.initial), 'agent policy must not cross the provider boundary')
  assert.ok(data.specs.length > 0, 'the loader must offer at least one provider spec')
  const nonJson: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'function') {
      nonJson.push(path)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
    }
  }
  for (const [index, spec] of data.specs.entries()) walk(spec, `specs[${index}]`)
  assert.deepEqual(nonJson, [], 'provider specs must stay a serializable slice with no SDK code')
})
