import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Parse-mode wiring for /api/data/import: parser refusals must come back as
 * caller errors with their message (never an opaque 500), and an oversized
 * file must say it was cut. The parser itself is pinned in parse.test.ts;
 * these cases pin the route's mapping of that contract onto HTTP.
 *
 * The data-io parse module runs REAL here (that is the point); only the
 * request identity and the resource lookup are stubbed.
 */
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    const mockUrl = new Map([
      ['../../../../lib/authz', 'mock:parse-route-authz'],
      ['../../../../lib/data-io/resources', 'mock:parse-route-resources'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:parse-route-authz') {
      return {
        format: 'module',
        source: `
          export function can() {
            return true
          }
          export async function guardPermission() {
            return { user: { orgId: 'org-1', id: 'actor-1' }, permissions: new Set(), allowedSubsidiaryIds: null }
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:parse-route-resources') {
      return {
        format: 'module',
        source: `
          export async function getResource() {
            return {
              descriptor: { key: 'probe', label: 'Probe', supportsImport: true },
              async fields() {
                return [
                  { key: 'documentDate', label: 'documentDate', kind: 'date' },
                  { key: 'amount', label: 'amount', kind: 'currency' },
                ]
              },
            }
          }
        `,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = '../../app/api/data/import/route.ts?parse-refusal-test'
const { POST } = await import(routeUrl) as typeof import('../../app/api/data/import/route.ts')
hooks.deregister()

function parseRequest(text: string) {
  return new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'parse', resource: 'probe', format: 'csv', text }),
  })
}

test('parse mode reports duplicate columns as a 400, not a 500', async () => {
  const response = await POST(parseRequest('documentDate,amount,amount\n2026-01-01,100,200\n'))
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.match(payload.error, /duplicate.*amount/i)
})

test('parse mode reports an empty file with the banking-domain status', async () => {
  const response = await POST(parseRequest('   \n'))
  assert.equal(response.status, 422)
  const payload = await response.json()
  assert.match(payload.error, /empty/i)
})

test('parse mode flags a file cut at the row cap', async () => {
  const lines = ['documentDate,amount']
  for (let i = 0; i < 20_001; i++) lines.push(`2026-01-01,${i}`)
  const response = await POST(parseRequest(lines.join('\n')))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.total, 20_000)
  assert.equal(payload.truncated, true)
  assert.equal(payload.maxRows, 20_000)
})

test('parse mode marks a small file complete', async () => {
  const response = await POST(parseRequest('documentDate,amount\n2026-01-01,100\n'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.total, 1)
  assert.equal(payload.truncated, false)
})
