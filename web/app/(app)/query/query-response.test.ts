import assert from 'node:assert/strict'
import test from 'node:test'
import { queryResponseError, readQueryResponse } from './query-response.ts'

test('decodes a structured JSON response', async () => {
  const response = new Response(JSON.stringify({ tables: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  assert.deepEqual(await readQueryResponse(response), { tables: [] })
})

test('reports an empty response without leaking the browser JSON parser error', async () => {
  const response = new Response(null, { status: 500 })
  await assert.rejects(readQueryResponse(response), /empty response \(HTTP 500\)/)
})

test('reports an HTML error response as invalid', async () => {
  const response = new Response('<!doctype html><h1>Internal Server Error</h1>', { status: 500 })
  await assert.rejects(readQueryResponse(response), /invalid response \(HTTP 500\)/)
})

test('uses a structured API error and falls back to the status code', () => {
  assert.equal(queryResponseError({ error: 'not found' }, 404), 'not found')
  assert.equal(queryResponseError({}, 503), 'Query request failed (HTTP 503)')
})
