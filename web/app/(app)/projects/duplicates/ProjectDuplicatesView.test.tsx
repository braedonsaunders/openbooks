import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

declare global {
  var __duplicatesToasts: { kind: string; message: string }[] | undefined
}

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4800/projects/duplicates' })
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia
}
if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = function () {}

const { registerHooks } = await import('node:module')
const { join } = await import('node:path')
const { pathToFileURL } = await import('node:url')
const worktreeUi = pathToFileURL(join(process.cwd(), 'packages', 'ui', 'src', 'index.ts')).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') return { shortCircuit: true, url: worktreeUi }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export function useRouter(){return{push(){},refresh(){},replace(){}}}export function usePathname(){return '/projects/duplicates'}export function useSearchParams(){return new URLSearchParams()}" }
    }
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast={success(m){(globalThis.__duplicatesToasts??=[]).push({kind:"success",message:String(m)})},error(m){(globalThis.__duplicatesToasts??=[]).push({kind:"error",message:String(m)})}}' }
    }
    return next(specifier, context)
  },
})

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { ProjectDuplicatesView } = await import('./ProjectDuplicatesView')

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

function group(key: string, projects = [
  { id: 'project-a', code: 'P-A', name: 'Alpha', customerId: 'customer-1', status: 'active', isActive: true },
  { id: 'project-b', code: 'P-B', name: 'Bravo', customerId: 'customer-1', status: 'active', isActive: true },
  { id: 'project-c', code: 'P-C', name: 'Charlie', customerId: 'customer-1', status: 'active', isActive: true },
]) {
  return { kind: 'source_ref' as const, key, projects }
}

function installFetch(handler: (url: URL, init?: RequestInit) => Response | null) {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost:4800')
    return handler(url, init) ?? Response.json({})
  }) as typeof fetch
  return () => { globalThis.fetch = prior }
}

async function mount(t: TestContext, handler: (url: URL, init?: RequestInit) => Response | null) {
  document.body.innerHTML = ''
  globalThis.__duplicatesToasts = []
  const restoreFetch = installFetch(handler)
  t.after(restoreFetch)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ProjectDuplicatesView />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return { host }
}

function rowFor(name: string): HTMLTableRowElement {
  const row = [...document.querySelectorAll('tr')].find((candidate) => candidate.textContent?.includes(name))
  assert.ok(row, `the duplicate row for ${name} is rendered`)
  return row as HTMLTableRowElement
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
}

async function preview(name: string) {
  const button = [...rowFor(name).querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Preview')
  assert.ok(button, `the duplicate row for ${name} offers Preview`)
  await click(button as HTMLButtonElement)
}

async function selectSurvivor(name: string) {
  const radio = rowFor(name).querySelector('input[type="radio"]')
  assert.ok(radio, `${name} can be selected as the surviving project`)
  await act(async () => {
    ;(radio as HTMLInputElement).click()
    await tick()
  })
}

test('a preview is hidden when the selected survivor changes', async (t) => {
  const projects = group('legacy-ref', [
    { id: 'project-a', code: 'P-A', name: 'Alpha', customerId: 'customer-1', status: 'active', isActive: true },
    { id: 'project-b', code: 'P-B', name: 'Bravo', customerId: 'customer-1', status: 'active', isActive: true },
    { id: 'project-c', code: 'P-C', name: 'Charlie', customerId: 'customer-1', status: 'active', isActive: true },
  ])
  const requests: URL[] = []
  await mount(t, (url) => {
    if (url.pathname === '/api/projects/duplicates') return Response.json({ groups: [projects] })
    if (url.pathname === '/api/projects/merge' && url.search) {
      requests.push(url)
      return Response.json({ moved: [{ table: 'documents', rows: 3 }], customRefs: [], alreadyMerged: false })
    }
    return null
  })

  await preview('Bravo')
  assert.match(rowFor('Bravo').textContent ?? '', /3 references will move\./)
  assert.equal(requests[0]?.searchParams.get('survivorId'), 'project-a')
  assert.equal(requests[0]?.searchParams.get('duplicateId'), 'project-b')

  await selectSurvivor('Charlie')
  assert.doesNotMatch(rowFor('Bravo').textContent ?? '', /3 references will move\./)
  assert.equal([...rowFor('Bravo').querySelectorAll('button')].some((button) => button.textContent?.startsWith('Merge (')), false)
})

test('a refused merge preview replaces stale impact with a group alert', async (t) => {
  const projects = group('legacy-ref', [
    { id: 'project-a', code: 'P-A', name: 'Alpha', customerId: 'customer-1', status: 'active', isActive: true },
    { id: 'project-b', code: 'P-B', name: 'Bravo', customerId: 'customer-1', status: 'active', isActive: true },
  ])
  let previewCalls = 0
  await mount(t, (url) => {
    if (url.pathname === '/api/projects/duplicates') return Response.json({ groups: [projects, group('other-ref')] })
    if (url.pathname === '/api/projects/merge' && url.search) {
      previewCalls += 1
      if (previewCalls === 1) return Response.json({ moved: [{ table: 'documents', rows: 2 }], customRefs: [], alreadyMerged: false })
      return Response.json({ error: 'A posted document prevents this merge direction' }, { status: 422 })
    }
    return null
  })

  await preview('Bravo')
  assert.match(rowFor('Bravo').textContent ?? '', /2 references will move\./)
  await preview('Bravo')

  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the typed preview refusal remains visible after its toast')
  assert.equal(alert.textContent, 'A posted document prevents this merge direction')
  assert.doesNotMatch(rowFor('Bravo').textContent ?? '', /2 references will move\./)
  assert.equal([...rowFor('Bravo').querySelectorAll('button')].some((button) => button.textContent?.startsWith('Merge (')), false)
  assert.equal(document.querySelectorAll('[role="alert"]').length, 1, 'the refusal is scoped to the affected duplicate group')
})
