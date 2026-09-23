// Run with:  node --import tsx --test web/lib/apps/tools.test.ts   (from repo root)
//
// Source-contract tests for the App-tools runtime (web/lib/apps/tools.ts):
// the server-only import chain (store → db) is not loaded here; these guard
// the governance wiring textually, while behavior is proven by the
// integration test against a private database.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tools = readFileSync(new URL('./tools.ts', import.meta.url), 'utf8')
const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8')
const mcpServer = readFileSync(new URL('../mcp/server.ts', import.meta.url), 'utf8')

function exportedBlock(source: string, signature: string, nextSignature: string): string {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `${signature} must remain defined`)
  const end = source.indexOf(nextSignature, start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

test('runAppTool re-checks every gate against the stored manifest', () => {
  // Apps-use first, then the stored row, status, spec, and grant ∩ caller.
  assert.match(tools, /if \(!opts\.userCan\('apps\.use'\)\) return \{ ok: false, error: 'forbidden', status: 403 \}/)
  assert.match(tools, /const app = await \(deps\?\.getApp \?\? getAppByKey\)\(opts\.orgId, opts\.appKey\)/)
  assert.match(tools, /if \(app\.status !== 'installed'\) return \{ ok: false, error: 'app is disabled', status: 403 \}/)
  assert.match(tools, /app\.manifest\.tools\?\.find\(\(t\) => t\.key === opts\.toolKey\)/)
  assert.match(
    tools,
    /if \(!permissionSetCovers\(granted, permission\) \|\| !opts\.userCan\(permission\)\)/,
  )
})

test('runAppTool validates input against the stored schema and invokes the envelope', () => {
  assert.match(tools, /jsonSchemaToZod\(spec\.inputSchema\)/)
  assert.match(tools, /parseToolInput\(zodSchema, opts\.input\)/)
  assert.match(tools, /if \(!parsed\.ok\) return \{ ok: false, error: parsed\.error, status: 422 \}/)
  assert.match(tools, /operation: `apps\.assistant_tool\.\$\{appToolAssistantName\(opts\.appKey, opts\.toolKey\)\}`/)
  assert.match(tools, /\(deps\?\.invoke \?\? invokeAppEndpointHandler\)\(/)
})

test('runAppTool refuses an omitted idempotencyKey instead of minting a random one', () => {
  const body = exportedBlock(tools, 'export async function runAppTool', 'export function toAssistantToolDef')
  // A missing key is a failure the caller can act on, not a silent new mutation.
  assert.match(body, /idempotencyKey is required/)
  assert.match(body, /status: 400/)
  assert.match(body, /idempotencyKey: idempotencyKey/)
  assert.doesNotMatch(body, /\?\? randomUUID\(\)/)
  assert.doesNotMatch(body, /idempotencyKey: opts\.idempotencyKey \?\?/)
  const refuse = body.indexOf('idempotencyKey is required')
  const invoke = body.indexOf('(deps?.invoke ?? invokeAppEndpointHandler)')
  assert.ok(refuse >= 0 && invoke > refuse, 'the refusal must run before the envelope is invoked')
})

test('toAssistantToolDef read path mints a fresh readInvocation nonce', () => {
  const body = exportedBlock(tools, 'export function toAssistantToolDef', 'export async function commitAppToolCommand')
  assert.match(body, /idempotencyKey: randomUUID\(\)/)
  // Mutating chat tools still propose; only the read execute() calls runAppTool.
  assert.match(body, /proposedApplicationCommand: \{/)
})

test('MCP app-tool execute reuses the request identity on writes and mints a nonce on reads', () => {
  const body = exportedBlock(mcpServer, 'const appCatalog', 'export async function createOpenBooksMcpServer')
  assert.match(
    body,
    /definition\.category === "write"\s*\? candidate\.requestId\s*: randomUUID\(\)/s,
  )
  assert.match(body, /runAppTool\(\{/)
  assert.match(body, /idempotencyKey/)
})

test('mutating app tools propose the shared confirmation card instead of executing', () => {
  assert.match(tools, /proposedApplicationCommand: \{/)
  assert.match(tools, /toolName: view\.name,/)
  assert.match(tools, /confirmToken: signApplicationCommand\(view\.name, parsed\.value, authz\)/)
  assert.match(tools, /note: 'Awaiting explicit user confirmation\. Nothing has been changed\.'/s)
  assert.match(tools, /requiresConfirmation: view\.readOnly \? undefined : true/)
})

test('read app tools cap the response that reaches the model', () => {
  assert.match(tools, /MAX_TOOL_RESPONSE_BYTES/)
  assert.match(tools, /tool response too large; narrow the request/)
})

test('mutating app tools commit through the shared confirmation scheme', () => {
  assert.match(tools, /export async function commitAppToolCommand/)
  assert.match(tools, /if \(!view \|\| view\.readOnly\) return \{ ok: false, error: 'unsupported_command', status: 400 \}/)
  assert.match(tools, /if \(!canRunTool\(authz, def, resolved\)\) return \{ ok: false, error: 'forbidden', status: 403 \}/)
  assert.match(tools, /verifyApplicationCommand\(view\.name, parsed\.value, confirmToken, authz\)/)
  assert.match(tools, /createHash\('sha256'\)\.update\(confirmToken\)\.digest\('hex'\)/)
  assert.match(tools, /idempotencyKey: commitKey/)
})

test('the application-command route delegates app_ tools to the shared committer', () => {
  const route = readFileSync(new URL('../../app/api/assistant/application-command/route.ts', import.meta.url), 'utf8')
  assert.match(route, /commitAppToolCommand\(gate, body\.toolName, body\.input, body\.confirmToken\)/)
  // Static commands keep their exact path: unknown static names still 400.
  assert.match(route, /return NextResponse\.json\(\{ error: "unsupported_command" \}, \{ status: 400 \}\)/)
})

test('platform schema/list/get mint a fresh readInvocation nonce like query', () => {
  const start = store.indexOf("if (opts.method.startsWith('platform.'))")
  assert.notEqual(start, -1, 'platform bridge dispatch must remain defined')
  const body = store.slice(start, store.indexOf("if (opts.method === 'records.list'"))
  // All four reads mint a nonce so a later identical fetch is not a stale replay.
  // The membership list lives on the extracted helper; pin that, not the
  // pre-extract `opts.method === 'platform.query'` literals.
  assert.match(body, /platformReadNeedsFreshInvocation\(opts\.method\)/)
  assert.match(store, /function platformReadNeedsFreshInvocation\(method: string\): boolean/)
  assert.match(store, /method === 'platform\.query'/)
  assert.match(store, /method === 'platform\.schema'/)
  assert.match(store, /method === 'platform\.list'/)
  assert.match(store, /method === 'platform\.get'/)
  assert.match(body, /platformReadNeedsFreshInvocation\(opts\.method\)\s*\n\s*\? \{ readInvocation: crypto\.randomUUID\(\) \}/)
  // Writes run under the caller's invocation key, never the payload hash:
  // two intentional repeats carry different keys and execute independently.
  assert.match(body, /idempotencyKey: invocationKey \?\? deriveAppInvocationKey\(\{/)
  assert.doesNotMatch(body, /opts\.method === 'platform\.query' \? \{ readInvocation/)
})

test('the bridge callBackend path forwards the caller key through the shared invoker', () => {
  const start = store.indexOf('export async function invokeAppEndpointHandler')
  assert.notEqual(start, -1, 'invokeAppEndpointHandler must remain defined')
  const body = store.slice(start, store.indexOf('\nfunction platformBridgeUnits'))
  assert.match(body, /operation: opts\.operation/)
  // The invoker takes a required caller key and never derives from payload.
  assert.match(body, /idempotencyKey: opts\.idempotencyKey,/)
  assert.doesNotMatch(body, /deriveAppInvocationKey/)
  assert.match(body, /audit: insertAppRun/)
  assert.match(body, /adapters\.platform = platform/)
  // The bridge delegate passes the client's invocation key (required, named
  // refusal without it) so a retried action replays instead of re-running.
  const bridge = store.slice(store.indexOf("if (opts.method === 'callBackend')"), store.indexOf('return { ok: false, error: `unknown method'))
  assert.match(bridge, /return invokeAppEndpointHandler\(\{/)
  assert.match(bridge, /operation: `apps\.call_backend\.\$\{endpointName\}`/)
  assert.match(bridge, /requireBridgeInvocationKey\(opts\.method, opts\.invocationKey\)/)
  assert.match(bridge, /idempotencyKey: keyed\.key/)
})
