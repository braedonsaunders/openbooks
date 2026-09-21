import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const webApp = join(here, '../..')

function walkRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkRouteFiles(child))
    else if (entry.name === 'route.ts') out.push(child)
  }
  return out
}

function handlers(source: string): Array<{ name: string; body: string }> {
  return [...source.matchAll(/export async function (GET|POST|PATCH|DELETE)\([\s\S]*?(?=\nexport async function |\s*$)/g)].map(
    (match) => ({ name: match[1]!, body: match[0] }),
  )
}

const routeFiles = walkRouteFiles(here)

test('every /api/apps handler gates before package, file, or store I/O', () => {
  assert.equal(routeFiles.length, 12)
  for (const file of routeFiles) {
    const source = readFileSync(file, 'utf8')
    const rel = file.slice(webApp.length + 1)
    const found = handlers(source)
    assert.ok(found.length > 0, `${rel} exports no HTTP handlers`)
    for (const { name, body } of found) {
      const gate = body.indexOf('await guardFeaturePermission')
      assert.ok(gate >= 0, `${rel} ${name} has no guardFeaturePermission`)
      const io = body.search(
        /readAppFile|getFrontendBundle|getAppByKey|getExtensionPackage|getExtensionDraft|runBridgeMethod|runExtensionAction|listListings|publishApp|unpublishApp|draftExtension|db\.execute/,
      )
      if (io >= 0) assert.ok(gate < io, `${rel} ${name} does I/O before the authz gate`)
    }
  }
})

test('package and file reads are session-org scoped and never touch the filesystem', () => {
  const files = readFileSync(join(here, '[key]/files/[...path]/route.ts'), 'utf8')
  assert.match(files, /guardFeaturePermission\('apps\.manage', 'apps'\)/)
  assert.match(files, /readAppFile\(gate\.user\.orgId, key, joined\(path\)\)/)
  assert.doesNotMatch(files, /readFileSync|createReadStream|from 'node:fs'|process\.cwd/)

  const pkg = readFileSync(join(here, '[key]/package/route.ts'), 'utf8')
  assert.match(pkg, /guardFeaturePermission\('apps\.manage', 'apps'\)/)
  assert.match(pkg, /getExtensionPackage\(/)
  assert.match(pkg, /applicationContextFromSession\(gate/)

  const bundle = readFileSync(join(here, '[key]/bundle/route.ts'), 'utf8')
  assert.match(bundle, /guardFeaturePermission\('apps\.use', 'apps'\)/)
  assert.match(bundle, /getFrontendBundle\(gate\.user\.orgId, key\)/)
})

test('sandbox document is apps.use/manage gated, org-scoped, and opaque-framed', () => {
  const sandbox = readFileSync(join(here, '[key]/sandbox/route.ts'), 'utf8')
  assert.match(sandbox, /draftId \? 'apps\.manage' : 'apps\.use'/)
  assert.match(sandbox, /getAppByKey\(gate\.user\.orgId, key\)/)
  assert.match(sandbox, /'Content-Security-Policy': APP_DOCUMENT_CSP/)
  assert.match(sandbox, /'X-Frame-Options': 'SAMEORIGIN'/)

  const frame = readFileSync(join(webApp, '(app)/apps/[key]/AppFrame.tsx'), 'utf8')
  const attr = frame.match(/<iframe[\s\S]*?sandbox="([^"]+)"/)
  assert.ok(attr, 'AppFrame iframe missing sandbox attribute')
  assert.equal(attr[1], 'allow-scripts')
  assert.match(frame, /e\.source !== iframe\.contentWindow/)
})

test('admin Apps HTTP clients target the gated App routes', () => {
  const admin = join(webApp, '(app)/admin/apps')
  assert.match(readFileSync(join(admin, 'ExtensionReview.tsx'), 'utf8'), /\/api\/apps\/drafts/)
  assert.match(readFileSync(join(admin, 'ExtensionRequest.tsx'), 'utf8'), /\/api\/apps\/import/)
  assert.match(readFileSync(join(admin, 'AppPackageEditor.tsx'), 'utf8'), /\/api\/apps\/drafts/)
  assert.match(readFileSync(join(admin, 'AppHistory.tsx'), 'utf8'), /\/api\/apps\/\$\{encodeURIComponent\(appKey\)\}\/management/)
  assert.match(readFileSync(join(admin, 'AppDefinitions.tsx'), 'utf8'), /\/api\/apps\/vocabulary/)
})

test('marketplace writes use the session org and sit behind apps.manage', () => {
  const source = readFileSync(join(here, 'marketplace/route.ts'), 'utf8')
  for (const { name, body } of handlers(source)) {
    assert.ok(body.includes("await guardFeaturePermission('apps.manage', 'apps')"), `${name} missing apps.manage`)
  }
  assert.match(source, /unpublishApp\(gate\.user\.orgId, gate\.user\.id, body\.key\)/)
  assert.match(source, /publishApp\(gate\.user\.orgId, gate\.user\.id, body\.key\)/)
  assert.match(source, /draftExtension\(\s*applicationContextFromSession\(gate/)
})

class NextResponse extends Response {
  static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
    return new NextResponse(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
  }
}
;(globalThis as typeof globalThis & { __obAppsNextResponse: typeof NextResponse }).__obAppsNextResponse =
  NextResponse

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return { shortCircuit: true, url: 'mock:ob-next' }
    if (specifier === '@/lib/feature-gates') return { shortCircuit: true, url: 'mock:ob-gates' }
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (
      specifier.startsWith('@/') ||
      specifier.startsWith('@openbooks/') ||
      specifier === 'drizzle-orm' ||
      specifier === 'fflate'
    ) {
      return { shortCircuit: true, url: 'mock:ob-empty' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:ob-next') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const NextResponse = globalThis.__obAppsNextResponse\n',
      }
    }
    if (url === 'mock:ob-gates') {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          "export async function guardFeaturePermission() { return globalThis.__obAppsNextResponse.json({ error: 'unauthorized' }, { status: 401 }) }\n",
      }
    }
    if (url === 'mock:ob-empty') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const sql = Object.assign((v) => v, { raw: (v) => v })
          export const db = { execute: async () => ({ rows: [] }) }
          export class AppError extends Error { status = 400 }
          export class ApplicationError extends Error { status = 400 }
          export class ZipBundleError extends Error {}
          export const jsonObject = {}
          export async function parseJsonBody() { return { ok: true, data: {} } }
          export function isUuid() { return true }
          export function applicationContextFromSession() { return {} }
          export async function listListings() { return { listings: [], total: 0 } }
          export async function publishApp() { return { id: 'x' } }
          export async function unpublishApp() {}
          export async function draftExtension() { return {} }
          export async function deleteApp() {}
          export async function getAppByKey() { return null }
          export async function setAppStatus() {}
          export async function readAppFile() { return { path: 'x', content: '', isBinary: false, contentType: 'text/plain' } }
          export async function getFrontendBundle() { return { entry: 'e', entryHtml: '', replacements: {} } }
          export async function runBridgeMethod() { return { ok: true, result: null } }
          export async function getExtensionPackage() { return { bundle: { manifest: {}, files: [] } } }
          export async function getExtensionDraft() { return { bundle: { files: [], manifest: {} } } }
          export function validateExtensionBundle() { return { files: [], manifest: { key: 'k', frontend: { renderer: 'sandbox', entry: 'e' }, endpoints: [] } } }
          export async function activateExtensionDraft() { return {} }
          export async function discardExtensionDraft() { return { discarded: true } }
          export async function previewExtensionPage() { return {} }
          export async function requireExtensionAuthor() {}
          export async function runExtensionAction() { return { ok: true } }
          export function can() { return true }
          export function parseManifest() { return { manifest: { key: 'k', name: 'n', frontend: { renderer: 'sandbox', entry: 'e' }, endpoints: [] } } }
          export function contentTypeFor() { return { contentType: 'text/plain' } }
          export function bridgeClientSource() { return '' }
          export function inlineDocument() { return '<html></html>' }
          export const APP_DOCUMENT_CSP = "default-src 'none'; sandbox allow-scripts"
          export const PAGE_REGISTRY = {}
          export const zipSync = () => new Uint8Array()
          export const strToU8 = () => new Uint8Array()
          export const MAX_COMPRESSED_BYTES = 1
          export function parseZipBundle() { return {} }
        `,
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
