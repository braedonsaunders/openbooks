import assert from 'node:assert/strict'
import test from 'node:test'
import { queryResponseError, readQueryResponse } from './query-response.ts'

// The console renders in the operator locale, so every refusal the helper
// raises comes from injected catalog messages — never hardcoded English.
const messages = {
  emptyResponse: (status: number) => `respuesta vacía (${status})`,
  invalidResponse: (status: number) => `respuesta inválida (${status})`,
}

test('decodes a structured JSON response', async () => {
  const response = new Response(JSON.stringify({ tables: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  assert.deepEqual(await readQueryResponse(response, messages), { tables: [] })
})

test('reports an empty response through the injected message', async () => {
  const response = new Response(null, { status: 500 })
  await assert.rejects(readQueryResponse(response, messages), /respuesta vacía \(500\)/)
})

test('reports an HTML error response as invalid through the injected message', async () => {
  const response = new Response('<!doctype html><h1>Internal Server Error</h1>', { status: 500 })
  await assert.rejects(readQueryResponse(response, messages), /respuesta inválida \(500\)/)
})

test('uses a structured API error and falls back to the injected message', () => {
  assert.equal(queryResponseError({ error: 'not found' }, 404, 'solicitud fallida (404)'), 'not found')
  assert.equal(queryResponseError({}, 503, 'solicitud fallida (503)'), 'solicitud fallida (503)')
})
