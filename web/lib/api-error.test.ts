import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ApiResponseError,
  apiJson,
  chunkArray,
  readApiBulkFailures,
  readApiErrorMessage,
  reconcileBulkResults,
  throwApiErrorIfNotOk,
} from './api-error.ts'

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

test('an errors array surfaces the joined validation reasons', async () => {
  const res = new Response(JSON.stringify({ errors: ['name required (max 200 chars)', 'graph: bad edge'] }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(
    await readApiErrorMessage(res, 'failed'),
    'name required (max 200 chars); graph: bad edge',
  )
})

test('apiJson returns the parsed success body without the caller touching res.json', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({ id: 'flow-1' })) as typeof fetch
  try {
    assert.deepEqual(
      await apiJson<{ id: string }>('/api/admin/flows', { method: 'POST' }, 'failed'),
      { id: 'flow-1' },
    )
  } finally {
    globalThis.fetch = prior
  }
})

test('apiJson throws the named server refusal on error, never a SyntaxError', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('<html>Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch
  try {
    await assert.rejects(
      apiJson<unknown>('/api/admin/flows', { method: 'POST' }, 'failed to save'),
      (error) =>
        error instanceof ApiResponseError &&
        error.status === 502 &&
        error.message === 'failed to save (status 502)',
    )
  } finally {
    globalThis.fetch = prior
  }
})

test('apiJson lets a network failure propagate untouched so callers show their own fallback', async () => {
  const prior = globalThis.fetch
  const offline = new TypeError('Failed to fetch')
  globalThis.fetch = (async () => {
    throw offline
  }) as typeof fetch
  try {
    await assert.rejects(apiJson<unknown>('/api/admin/flows', undefined, 'failed'), (error) => error === offline)
  } finally {
    globalThis.fetch = prior
  }
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

test('chunkArray splits a 100-id selection into bounded batches', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`)
  const chunks = chunkArray(ids, 50)
  assert.equal(chunks.length, 2)
  assert.ok(chunks.every((chunk) => chunk.length <= 50))
  assert.deepEqual(chunks.flat(), ids)
  assert.deepEqual(chunkArray([], 50), [])
  assert.throws(() => chunkArray(ids, 0), /positive integer/)
})

test('reconcileBulkResults flags ids the server never answered', () => {
  assert.deepEqual(
    reconcileBulkResults(
      ['a', 'b', 'c'],
      [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'duplicate invoice INV-9' },
      ],
      'not processed',
    ),
    [
      { id: 'b', error: 'duplicate invoice INV-9' },
      { id: 'c', error: 'not processed' },
    ],
  )
  assert.deepEqual(reconcileBulkResults(['a'], [{ id: 'a', ok: true }], 'not processed'), [])
  assert.deepEqual(reconcileBulkResults(['a'], undefined, 'not processed'), [
    { id: 'a', error: 'not processed' },
  ])
})

test("a schema refusal names the field the operator must correct", async () => {
  const body = { error: "must be a valid id", issues: [{ path: "adjustmentAccountId", message: "must be a valid id" }] };
  const response = new Response(JSON.stringify(body), { status: 422, headers: { "content-type": "application/json" } });
  assert.equal(await readApiErrorMessage(response, "Save failed"), "Adjustment account id: must be a valid id");
  const nested = { error: "Required", issues: [{ path: "lines.0.taxCodeId", message: "Required" }] };
  const second = new Response(JSON.stringify(nested), { status: 400, headers: { "content-type": "application/json" } });
  assert.equal(await readApiErrorMessage(second, "Save failed"), "Tax code id: Required");
});
