import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Health wiring for the PDF renderer: the readiness payload reports renderer
// availability without gating routing readiness on it. The route is
// unauthenticated, so it never discloses the executable path or remedy. db + worker heartbeat are mocked; the pdf probe and the
// route are REAL.

const mockSources = new Map<string, string>([
  ['db', `export const pool = { query: async () => ({ rows: [] }) }`],
  ['jobs', `export async function getWorkerHeartbeat() { return new Date().toISOString() }`],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', mockUrl('db')],
  ['@openbooks/jobs', mockUrl('jobs')],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    if (parsed.search.startsWith('?mock=')) {
      const src = mockSources.get(parsed.searchParams.get('mock') ?? '')
      if (src !== undefined) return { format: 'module', source: src, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?openbooks-health-renderer-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function dependencies(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await GET(new Request('http://openbooks.test/api/v1/health?include=dependencies'))
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('a present executable reports the renderer ready', async () => {
  await withEnv(
    { NODE_ENV: 'test', SESSION_SECRET: 'health-test-secret', PUPPETEER_EXECUTABLE_PATH: process.execPath },
    async () => {
      const { status, body } = await dependencies()
      assert.equal(status, 200)
      assert.deepEqual((body.dependencies as Record<string, string>).pdfRenderer, 'ok')
      assert.equal(body.renderer, undefined, 'no renderer detail on the unauthenticated route')
      assert.ok(!JSON.stringify(body).includes(process.execPath), 'the executable path is never disclosed')
    },
  )
})

test('a missing executable reports unavailable but stays routable', async () => {
  await withEnv(
    {
      NODE_ENV: 'test',
      SESSION_SECRET: 'health-test-secret',
      PUPPETEER_EXECUTABLE_PATH: '/nonexistent-dir-7c2/chromium',
    },
    async () => {
      const { status, body } = await dependencies()
      // Not gated: a renderer-only incident must not drain the pool — the PDF
      // routes refuse individually.
      assert.equal(status, 200)
      assert.equal(body.status, 'ok')
      assert.deepEqual((body.dependencies as Record<string, string>).pdfRenderer, 'unavailable')
      assert.equal(body.renderer, undefined, 'no renderer detail on the unauthenticated route')
      assert.ok(!JSON.stringify(body).includes('/nonexistent-dir-7c2'), 'the executable path is never disclosed')
    },
  )
})

test('plain liveness is unchanged', async () => {
  await withEnv({ NODE_ENV: 'test', SESSION_SECRET: 'health-test-secret' }, async () => {
    const response = await GET(new Request('http://openbooks.test/api/v1/health'))
    assert.equal(response.status, 200)
    const body = (await response.json()) as { status: string; service: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.service, 'openbooks-api')
  })
})
