import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { GET } from './route'

const request = (query: string) => new NextRequest(`http://localhost/api/i18n/catalog?${query}`)

test('the current catalog version is served as an immutable resource', async () => {
  const probe = await GET(request('locale=fr'))
  const version = probe.headers.get('etag')?.replaceAll('"', '')
  assert.ok(version, 'the response must name its content version')
  assert.equal(probe.headers.get('cache-control'), 'no-store', 'an unnamed version must not be cached')

  const current = await GET(request(`locale=fr&v=${version}`))
  assert.equal(current.status, 200)
  assert.equal(current.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  const messages = (await current.json()) as Record<string, unknown>
  assert.ok(messages.common && typeof messages.common === 'object', 'the catalog carries every namespace')
})

test('a stale version is answered with the current catalog, uncached', async () => {
  const response = await GET(request('locale=en&v=stale'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('an unsupported locale is refused', async () => {
  const response = await GET(request('locale=xx'))
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'unsupported_locale' })
})
