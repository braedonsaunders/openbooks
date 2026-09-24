import assert from 'node:assert/strict'
import test from 'node:test'

// F4T2-9 (an empty name persisted the LOCALIZED `builder.untitled`, which no
// sentinel check recognizes — an "untitled" board in another language sailed
// through the publish gate): the stored name is the canonical sentinel and
// the dialog still shows the localized placeholder.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/insights/dashboards',
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
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}

declare global {
  var __dashToasts: { kind: string; message: string }[] | undefined
  var __dashPosted: Record<string, unknown>[] | undefined
}

Object.assign(globalThis, {
  __dashToasts: [] as { kind: string; message: string }[],
  __dashPosted: [] as Record<string, unknown>[],
  __dashTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__dashTestRouter}',
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__dashToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__dashToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const { NewDashboardButton } = await import('./NewDashboardButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(locale: string) {
  const messages = (await import(`../../../../messages/${locale}`)).default
  ;(globalThis as Record<string, unknown>).__dashToasts = []
  ;(globalThis as Record<string, unknown>).__dashPosted = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    ;(globalThis.__dashPosted ?? []).push(
      JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')),
    )
    return Response.json({ id: 'dash-1' })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <NewDashboardButton />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === label,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `must offer a ${label} button`)
  return btn
}

test('an empty name persists the canonical sentinel, not the localized display string (F4T2-9)', async (t) => {
  const { host, root } = await mount('de')
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    findButton(host, 'Neues Dashboard').click()
    await tick()
    await tick()
  })
  // The dialog shows the localized placeholder while storing the sentinel.
  const nameInput = document.body.querySelector('input#new-dashboard-name') as HTMLInputElement | null
  assert.ok(nameInput, 'the dialog must offer the name field')
  assert.equal(nameInput.placeholder, 'Management-Überblick')
  await act(async () => {
    findButton(document.body, 'Erstellen').click()
    await tick()
    await tick()
    await tick()
  })
  assert.equal(globalThis.__dashPosted?.length, 1, 'saving posts once')
  assert.equal(
    (globalThis.__dashPosted?.[0] as { name?: unknown })?.name,
    'Untitled dashboard',
    'the stored name is the canonical sentinel the publish gate recognizes',
  )
})
