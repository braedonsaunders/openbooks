import assert from 'node:assert/strict'
import test from 'node:test'

// F-t05-012 (statement-import Preview on junk CSV): the preview POST 422s
// with a typed { error } body, but the dialog neither toasts usefully nor
// persists anything — the click reads as dead. The dialog must persist the
// typed refusal as a role=alert (cleared on the next edit) and toast it,
// mirroring the RunBuilder F-t04-005 pattern; an unreadable error body must
// fall back to the generic request-failed copy instead of a SyntaxError.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/banking/acc-1',
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
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  (globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  previewStatus: 422 as number,
  previewBody: { error: 'CSV has a header but no data rows' } as unknown,
}
Object.assign(globalThis, {
  __importTestToasts: script.toasts,
  __importTestRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__importTestRouter}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__importTestToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__importTestToasts.push({kind:"error",message:String(m)})}};export function Toaster(){return null}',
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
const { MoneyProvider } = await import('../../../../components/money-provider')
const { ImportStatementButton } = await import('./ImportStatementButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function setNativeValue(el: HTMLElement, value: string) {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLSelectElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  setter.call(el, value)
}

async function mount() {
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init?.body as string) ?? '{}')) as { mode?: string }
    if (url === '/api/banking/import' && body.mode === 'columns') {
      return Response.json({ header: ['hello', 'not', 'a', 'statement'] })
    }
    if (url === '/api/banking/import' && body.mode === 'preview') {
      if (script.previewStatus === 200) return Response.json({ lines: [], imported: 0, duplicates: 0 })
      return Response.json(script.previewBody, { status: script.previewStatus })
    }
    throw new Error(`unexpected fetch ${String(url)} ${body.mode}`)
  }) as typeof fetch
  script.toasts.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MoneyProvider currency="CAD">
          <ImportStatementButton accountId="acc-1" />
        </MoneyProvider>
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function clickButton(text: string) {
  const btn = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  ) as HTMLButtonElement | undefined
  assert.ok(btn, `button "${text}" must render`)
  return btn
}

/** Drive the dialog to a mapped junk-CSV CSV state with Preview enabled. */
async function mapJunkCsv() {
  await act(async () => {
    clickButton('Import statement').click()
    await tick()
    await tick()
  })
  const formatSelect = document.querySelector('select') as HTMLSelectElement
  assert.ok(formatSelect, 'the format picker must render')
  await act(async () => {
    setNativeValue(formatSelect, 'csv')
    formatSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
    await tick()
  })
  const area = document.querySelector('textarea') as HTMLTextAreaElement
  assert.ok(area, 'the statement text box must render')
  await act(async () => {
    setNativeValue(area, 'hello,not,a,statement')
    area.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  await act(async () => {
    clickButton('Detect columns').click()
    await tick()
    await tick()
  })
  const selects = [...document.querySelectorAll('select')]
  // format + date + amount + description (+ optional debit/ref/txn-id)
  assert.ok(selects.length >= 4, 'the column mapping selects must render')
  const [, dateSel, amountSel, descSel] = selects as HTMLSelectElement[]
  await act(async () => {
    for (const [sel, value] of [[dateSel, '0'], [amountSel, '1'], [descSel, '2']] as const) {
      setNativeValue(sel!, value)
      sel!.dispatchEvent(new window.Event('change', { bubbles: true }))
      await tick()
    }
  })
}

test('a refused import preview persists the typed server reason as a dialog alert (F-t05-012)', async (t) => {
  script.previewStatus = 422
  script.previewBody = { error: 'CSV has a header but no data rows' }
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await mapJunkCsv()
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'the refused preview must persist a dialog-level alert')
  assert.match(alert.textContent ?? '', /header but no data rows/)
  const errors = script.toasts.filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1, 'the refused preview must also toast once')
  assert.match(errors[0]!.message, /header but no data rows/)
})

test('an unreadable preview refusal falls back to the generic copy (F-t05-012)', async (t) => {
  script.previewStatus = 500
  script.previewBody = '<html>proxy boom</html>'
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await mapJunkCsv()
  // Non-JSON body: override fetch to return raw HTML for the preview call.
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String((init?.body as string) ?? '{}')) as { mode?: string }
    if (body.mode === 'columns') return Response.json({ header: ['hello', 'not', 'a', 'statement'] })
    return new Response('<html>proxy boom</html>', { status: 500 })
  }) as typeof fetch
  await act(async () => {
    clickButton('Preview').click()
    await tick()
    await tick()
  })
  const alert = document.querySelector('[role="alert"]')
  assert.ok(alert, 'an unreadable refusal must still persist an alert')
  assert.doesNotMatch(alert.textContent ?? '', /Unexpected token/)
  const errors = script.toasts.filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1, 'an unreadable refusal must toast once')
})
