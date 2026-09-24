import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Every /api/apps handler must refuse an unauthenticated caller BEFORE any
// package, file, or store I/O. This imports the real route modules with only
// the session identity stubbed out: the real feature/permission gates run,
// and any handler that touched I/O first would throw (no database, no
// session) instead of answering the gate's 401.

const webRoot = fileURLToPath(new URL('../../..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, url: 'mock:apps-intl' }
    }
    // Session boundary only: no signed-in user, so every real gate below
    // refuses before any store, package, or filesystem work.
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return { shortCircuit: true, url: 'mock:apps-session' }
    }
    if (specifier.startsWith('@/lib/')) {
      return nextResolve(
        pathToFileURL(`${webRoot}/lib/${specifier.slice('@/lib/'.length)}.ts`).href,
        context,
      )
    }
    if (specifier.startsWith('@openbooks/engine/')) {
      return nextResolve(
        pathToFileURL(`${repoRoot}/engine/${specifier.slice('@openbooks/engine/'.length)}`).href,
        context,
      )
    }
    // @openbooks/schema resolves through the workspace symlink in
    // node_modules; mapping it here would bypass its package exports.
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:apps-intl') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function getTranslations() { return (key) => key }
          export async function getLocale() { return 'en' }`,
      }
    }
    if (url === 'mock:apps-session') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export async function currentUser() { return null }`,
      }
    }
    return nextLoad(url, context)
  },
})

const params = (value: Record<string, unknown>) => ({
  params: Promise.resolve(value),
})

test('unauthenticated App HTTP handlers refuse with 401 before any store work', async () => {
  const req = () => new Request('http://openbooks.test/api/apps', { method: 'POST', body: '{}' })
  const get = () => new Request('http://openbooks.test/api/apps')
  const calls: Array<Promise<Response>> = []

  const marketplace = await import(`./marketplace/route.ts?unauth=${Date.now()}`)
  calls.push(marketplace.GET())
  calls.push(marketplace.POST(req()))

  const imported = await import(`./import/route.ts?unauth=${Date.now()}`)
  calls.push(imported.POST(req()))

  const drafts = await import(`./drafts/route.ts?unauth=${Date.now()}`)
  calls.push(drafts.GET(get()))
  calls.push(drafts.POST(req()))

  const vocabulary = await import(`./vocabulary/route.ts?unauth=${Date.now()}`)
  calls.push(vocabulary.GET())

  const app = await import(`./[key]/route.ts?unauth=${Date.now()}`)
  calls.push(app.GET(get(), params({ key: 'demo' })))
  calls.push(app.PATCH(req(), params({ key: 'demo' })))
  calls.push(app.DELETE(get(), params({ key: 'demo' })))

  const files = await import(`./[key]/files/[...path]/route.ts?unauth=${Date.now()}`)
  calls.push(files.GET(get(), params({ key: 'demo', path: ['frontend', 'index.html'] })))

  const bundle = await import(`./[key]/bundle/route.ts?unauth=${Date.now()}`)
  calls.push(bundle.GET(get(), params({ key: 'demo' })))

  const bridge = await import(`./[key]/bridge/route.ts?unauth=${Date.now()}`)
  calls.push(bridge.POST(req(), params({ key: 'demo' })))

  const actions = await import(`./[key]/actions/route.ts?unauth=${Date.now()}`)
  calls.push(actions.POST(req(), params({ key: 'demo' })))

  const management = await import(`./[key]/management/route.ts?unauth=${Date.now()}`)
  calls.push(management.GET(get(), params({ key: 'demo' })))

  const sandbox = await import(`./[key]/sandbox/route.ts?unauth=${Date.now()}`)
  calls.push(sandbox.GET(get(), params({ key: 'demo' })))

  const pkg = await import(`./[key]/package/route.ts?unauth=${Date.now()}`)
  calls.push(pkg.GET(get(), params({ key: 'demo' })))

  const responses = await Promise.all(calls)
  assert.equal(responses.length, 16)
  for (const response of responses) {
    assert.equal(response.status, 401, await response.text())
  }
  hooks.deregister()
})
