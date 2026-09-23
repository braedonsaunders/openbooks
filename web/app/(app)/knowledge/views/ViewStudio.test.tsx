import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

// UX-06: a new View Studio card must open in an honest unsaved/draft state —
// "All changes saved" may only appear after a real save reads back its id.
// An existing view loaded from the database still opens as saved.

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/knowledge/views?view=new',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
}
if (typeof dom.window.requestAnimationFrame !== 'function') {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame
  dom.window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame
}
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  created: [] as Array<Record<string, unknown>>,
}
Object.assign(globalThis, {
  __viewStudioToasts: script.toasts,
  __viewStudioRouter: {
    push() {},
    refresh() {},
    replace() {},
    back() {},
    prefetch() {},
  },
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return globalThis.__viewStudioRouter}export function usePathname(){return "/knowledge/views"}export function useSearchParams(){return new URLSearchParams()}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href,className:p.className},p.children)}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__viewStudioToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__viewStudioToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__viewStudioToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
      }
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
const { REPORT_ENTITY_MAP, defaultColumnsFor } = await import('@openbooks/reports')
const { ViewStudio } = await import('./ViewStudio')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const entity = REPORT_ENTITY_MAP.ledger_lines!

function blankView() {
  return {
    id: 'new',
    org_id: 'org-1',
    slug: 'new',
    name: '',
    description: null,
    query: {
      entity: 'ledger_lines',
      mode: 'rows',
      columns: defaultColumnsFor(entity),
      breakouts: [],
      measures: [{ fn: 'count' }],
      filters: null,
      groupBy: null,
      sorts: null,
      limit: 1000,
    },
    layout: null,
    scope: 'private',
    owner_id: 'user-1',
    allowed_roles: null,
    created_at: '2026-09-23T00:00:00Z',
    updated_at: '2026-09-23T00:00:00Z',
  }
}

async function mountStudio(t: TestContext, createMode: boolean): Promise<void> {
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url === '/api/views' && (init?.method ?? 'GET') === 'POST') {
      script.created.push(JSON.parse(String(init?.body ?? '{}')))
      return Response.json({ id: 'view-1' })
    }
    return Response.json({ result: null })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = prior
  })
  const rootHandle = createRoot(document.body)
  t.after(async () => {
    await act(async () => {
      rootHandle.unmount()
    })
    for (const node of [...document.body.children]) node.remove()
  })
  script.toasts.length = 0
  script.created.length = 0
  await act(async () => {
    rootHandle.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ViewStudio
          {...({
            view: blankView(),
            canCreate: true,
            canAdmin: false,
            company: 'Acme',
            hiddenEntityKeys: [],
            inventoryEnabled: true,
            createMode,
          } as unknown as React.ComponentProps<typeof ViewStudio>)}
        />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
    await tick()
  })
}

test('a new view studio opens unsaved, never claiming a save', async (t) => {
  await mountStudio(t, true)
  const body = document.body.textContent ?? ''
  assert.match(body, /Unsaved changes/, 'create mode must open in an honest unsaved state')
  assert.doesNotMatch(body, /All changes saved/, 'create mode must not claim a save before the first Save')
})

test('an existing view still opens as saved', async (t) => {
  await mountStudio(t, false)
  const body = document.body.textContent ?? ''
  assert.match(body, /All changes saved/, 'an unedited persisted view is honestly saved')
})

test('the saved claim appears only after the create read-back', async (t) => {
  await mountStudio(t, true)
  const save = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === 'Save',
  ) as HTMLButtonElement | undefined
  assert.ok(save, 'create mode must offer an explicit Save')
  await act(async () => {
    save.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
    await tick()
  })
  await tick()
  assert.equal(script.created.length, 1, 'Save must POST the view exactly once')
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success' && /All changes saved/.test(toast.message)),
    'the saved claim must follow the real save read-back',
  )
})
