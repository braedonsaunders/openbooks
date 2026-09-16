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
  assert.match(tools, /idempotencyKey: opts\.idempotencyKey \?\? randomUUID\(\)/)
  assert.match(tools, /\(deps\?\.invoke \?\? invokeAppEndpointHandler\)\(/)
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

test('the bridge callBackend path keeps its exact derivation through the shared invoker', () => {
  const start = store.indexOf('export async function invokeAppEndpointHandler')
  assert.notEqual(start, -1, 'invokeAppEndpointHandler must remain defined')
  const body = store.slice(start, store.indexOf('\nfunction platformBridgeUnits'))
  assert.match(body, /operation: opts\.operation/)
  assert.match(body, /idempotencyKey: opts\.idempotencyKey \?\? deriveAppInvocationKey\(\{/)
  assert.match(body, /audit: insertAppRun/)
  assert.match(body, /adapters\.platform = platform/)
  // The bridge delegate passes no caller key, so byte-identical retries collapse as before.
  const bridge = store.slice(store.indexOf("if (opts.method === 'callBackend')"), store.indexOf('return { ok: false, error: `unknown method'))
  assert.match(bridge, /return invokeAppEndpointHandler\(\{/)
  assert.match(bridge, /operation: `apps\.call_backend\.\$\{endpointName\}`/)
  assert.doesNotMatch(bridge, /idempotencyKey/)
})
