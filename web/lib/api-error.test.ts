import assert from 'node:assert/strict'
import test from 'node:test'
import { readApiBulkFailures, readApiErrorMessage, throwApiErrorIfNotOk } from './api-error.ts'

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

test('a message-only envelope still surfaces the named refusal', async () => {
  const res = new Response(JSON.stringify({ message: 'capture is not operational' }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(await readApiErrorMessage(res, 'failed'), 'capture is not operational')
})

test('a remedy is appended to the named refusal', async () => {
  const res = new Response(
    JSON.stringify({ error: 'SUI rate is not configured', remedy: 'add a rate in Company Settings' }),
    { status: 422, headers: { 'content-type': 'application/json' } },
  )
  assert.equal(
    await readApiErrorMessage(res, 'failed'),
    'SUI rate is not configured — add a rate in Company Settings',
  )
})

test('blank and non-string error fields fall through to the fallback, never an empty toast', async () => {
  for (const body of ['{"error":"   "}', '{"error":42}', '{"error":null}']) {
    const res = new Response(body, {
      status: 422,
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(await readApiErrorMessage(res, 'failed'), 'failed (status 422)')
  }
})

test('a detail-only ping refusal surfaces the provider reason', async () => {
  const res = new Response(JSON.stringify({ ok: false, detail: 'connection timed out after 10s' }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(await readApiErrorMessage(res, 'failed'), 'connection timed out after 10s')
})

test('a blank fallback can never produce an empty message', async () => {
  const res = new Response('<html>proxy page</html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  })
  assert.equal(await readApiErrorMessage(res, '   '), 'request failed (status 502)')
})

test('throwApiErrorIfNotOk returns silently on success so the body parses after the ok check', async () => {
  const res = new Response(JSON.stringify({ id: 'x' }), { status: 200 })
  await throwApiErrorIfNotOk(res, 'failed')
  assert.equal(((await res.json()) as { id: string }).id, 'x')
})

test('throwApiErrorIfNotOk throws the named server error, never Error(undefined)', async () => {
  const res = new Response(JSON.stringify({ error: 'revision is stale; reopen the drawer' }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(() => throwApiErrorIfNotOk(res, 'failed'), /revision is stale/)
  const empty = new Response(null, { status: 500 })
  await assert.rejects(() => throwApiErrorIfNotOk(empty, 'failed'), /failed \(status 500\)/)
})

test('readApiBulkFailures carries one named reason per failed item', () => {
  assert.deepEqual(
    readApiBulkFailures({
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'duplicate invoice INV-9' },
        { id: 'c', ok: false },
      ],
    }),
    [
      { id: 'b', error: 'duplicate invoice INV-9' },
      { id: 'c', error: 'failed' },
    ],
  )
})

test('readApiBulkFailures never throws on an unparseable body', () => {
  assert.deepEqual(readApiBulkFailures(null), [])
  assert.deepEqual(readApiBulkFailures({ results: 'nope' }), [])
  assert.deepEqual(readApiBulkFailures({ results: [null, 42, { ok: true }] }), [])
})
