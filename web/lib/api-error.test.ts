import assert from 'node:assert/strict'
import test from 'node:test'
import { readApiErrorMessage } from './api-error.ts'

// The latent client defect: every error path parsed the body BEFORE checking
// the status, so a non-JSON error body threw a SyntaxError and the operator
// saw a parse error instead of the server's message (or any status at all).
test('a JSON error body yields the server message', async () => {
  const res = new Response(JSON.stringify({ error: 'No state on this AU payroll profile' }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(await readApiErrorMessage(res, 'failed'), 'No state on this AU payroll profile')
})

test('a non-JSON error body yields the fallback with the status, never a SyntaxError', async () => {
  const res = new Response('<html><body>Bad Gateway</body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  })
  assert.equal(await readApiErrorMessage(res, 'failed to load'), 'failed to load (status 502)')
})

test('an empty error body yields the fallback with the status', async () => {
  const res = new Response(null, { status: 500 })
  assert.equal(await readApiErrorMessage(res, 'failed'), 'failed (status 500)')
})

test('a JSON body without an error field yields the fallback with the status', async () => {
  const res = new Response(JSON.stringify({ ok: false }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(await readApiErrorMessage(res, 'failed'), 'failed (status 422)')
})
