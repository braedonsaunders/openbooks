import assert from 'node:assert/strict'
import test from 'node:test'

// C-73 (a PATCH assignments 422 — regime not installed, invalid class —
// became throw new Error() with an empty message; the optimistic Select
// rolled back and the toast was the generic assignmentFailed): the toast
// carries the server's named refusal, and the rollback is kept.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/setup/tax-depreciation',
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
  var __taxToasts: { kind: string; message: string }[] | undefined
}

Object.assign(globalThis, {
  __taxToasts: [] as { kind: string; message: string }[],
  __taxTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__taxTestRouter}',
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
        url: "data:text/javascript,export const toast={success(m){(globalThis.__taxToasts??=[]).push({kind:'success',message:String(m)})},error(m){(globalThis.__taxToasts??=[]).push({kind:'error',message:String(m)})}};export function Toaster(){return null}",
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
const messages = (await import('../../../../../messages/en')).default
const { TaxDepreciationSetup } = await import('./TaxDepreciationSetup')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const props = {
  companyCountry: 'CA',
  packs: [],
  installedCodes: [],
  regimes: [
    {
      code: 'ca_cca',
      name: 'CCA classes',
      classAttribute: 'cca_class',
      classes: [
        { code: '50', name: 'Class 50' },
        { code: '10', name: 'Class 10' },
      ],
    },
  ],
  categories: [{ id: 'cat-1', name: 'Laptops', taxAttributes: {} }],
}

async function mount(patchImpl: (body: Record<string, unknown>) => Response) {
  ;(globalThis as Record<string, unknown>).__taxToasts = []
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    return patchImpl(JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')))
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <TaxDepreciationSetup {...props} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function assignmentSelect(host: Element): HTMLSelectElement {
  const select = host.querySelector('table select') as HTMLSelectElement | null
  assert.ok(select, 'the assignments table must render a class select')
  return select
}

async function choose(select: HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(select),
    'value',
  )
  await act(async () => {
    descriptor?.set?.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
    await tick()
    await tick()
  })
}

test('a refused assignment toasts the named refusal and rolls back (C-73)', async (t) => {
  const { host, root } = await mount(() => Response.json({ error: 'regime is not installed' }, { status: 422 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const select = assignmentSelect(host)
  await choose(select, '50')
  const errors = (globalThis.__taxToasts ?? []).filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1, 'the refusal must toast exactly once')
  assert.match(errors[0]!.message, /regime is not installed/, 'the toast carries the named refusal, not the generic fallback')
  assert.equal(select.value, '', 'the optimistic select rolls back to the previous assignment')
})

test('an accepted assignment sticks with no error toast (C-73)', async (t) => {
  const { host, root } = await mount(() => Response.json({ ok: true }, { status: 200 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const select = assignmentSelect(host)
  await choose(select, '50')
  assert.deepEqual(
    (globalThis.__taxToasts ?? []).filter((toast) => toast.kind === 'error'),
    [],
    'an accepted assignment must not toast',
  )
  assert.equal(select.value, '50', 'the accepted assignment stays selected')
})
