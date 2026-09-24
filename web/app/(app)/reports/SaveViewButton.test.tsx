import assert from 'node:assert/strict'
import test from 'node:test'

// F1T-4 (save() used the native prompt() and toasted the generic saveFailed,
// dropping the server's named refusal): the house prompt dialog collects the
// name and the refusal surfaces through the shared helper.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/reports/pnl?period=2026-01',
})
const globals = globalThis as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  if (globals[key] === undefined) globals[key] = domWindow[key]
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
  var __saveViewToasts: { kind: string; message: string }[] | undefined
  var __saveViewName: string | null | undefined
  var __saveViewPromptTitles: string[] | undefined
}

Object.assign(globalThis, {
  __saveViewToasts: [] as { kind: string; message: string }[],
  __saveViewName: 'My view',
  __saveViewPromptTitles: [] as string[],
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}export function usePathname(){return "/reports/pnl"}export function useSearchParams(){return new URLSearchParams("period=2026-01")}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(m){(globalThis.__saveViewToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__saveViewToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
      }
    }
    if (specifier.endsWith('/lib/prompt')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function promptDialog(o){(globalThis.__saveViewPromptTitles??=[]).push(o?.title ?? "");return globalThis.__saveViewName ?? null}',
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
const messages = (await import('../../../messages/en')).default
const { SaveViewButton } = await import('./SaveViewButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(saveImpl: (body: Record<string, unknown>) => Promise<Response>) {
  ;(globalThis as Record<string, unknown>).__saveViewToasts = []
  ;(globalThis as Record<string, unknown>).__saveViewPromptTitles = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    return saveImpl(JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')))
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SaveViewButton />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

async function clickSave(host: Element) {
  const btn = host.querySelector('button') as HTMLButtonElement | null
  assert.ok(btn, 'must render the save button')
  await act(async () => {
    btn.click()
    await tick()
    await tick()
    await tick()
  })
  return btn
}

test('a named refusal surfaces instead of the generic fallback (F1T-4)', async (t) => {
  ;(globalThis as Record<string, unknown>).__saveViewName = 'My view'
  const seen: Record<string, unknown>[] = []
  const { host, root } = await mount(async (body) => {
    seen.push(body)
    return Response.json({ error: 'name and a /reports path required' }, { status: 400 })
  })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickSave(host)
  assert.deepEqual(
    (seen[0] as { name?: unknown })?.name,
    'My view',
    'the prompted name is posted',
  )
  const errors = (globalThis.__saveViewToasts ?? []).filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /name and a \/reports path required/)
  assert.match(host.textContent ?? '', /Save view/, 'a refused save does not flip to Saved')
})

test('a successful save flips the button and toasts the name (F1T-4)', async (t) => {
  ;(globalThis as Record<string, unknown>).__saveViewName = 'My view'
  const { host, root } = await mount(async () => Response.json({ ok: true }, { status: 200 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickSave(host)
  assert.match(host.textContent ?? '', /Saved/, 'the button reflects the saved state')
  assert.ok(
    (globalThis.__saveViewToasts ?? []).some(
      (toast) => toast.kind === 'success' && toast.message.includes('My view'),
    ),
    'success toasts the saved name',
  )
})

test('cancelling the name dialog posts nothing (F1T-4)', async (t) => {
  ;(globalThis as Record<string, unknown>).__saveViewName = null
  let calls = 0
  const { host, root } = await mount(async () => {
    calls += 1
    return Response.json({ ok: true }, { status: 200 })
  })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await clickSave(host)
  assert.equal(calls, 0, 'cancel posts nothing')
  assert.match(
    (globalThis.__saveViewPromptTitles ?? []).join('\n'),
    /Name this view/,
    'the house dialog carries the translated prompt',
  )
})
