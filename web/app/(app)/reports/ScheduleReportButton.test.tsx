import assert from 'node:assert/strict'
import test from 'node:test'

// F1T-3 (a refused schedules fetch returned silently, leaving `schedules`
// null and the drawer stuck on Loading forever): the refusal lands in a
// named error state with a retry, and a retry that succeeds renders the
// editor.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/reports/pnl',
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

Object.assign(globalThis, {
  __scheduleFetchImpl: null as null | (() => Promise<Response>),
})
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}export function usePathname(){return "/"}export function useSearchParams(){return new URLSearchParams()}',
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
const { ScheduleReportButton } = await import('./ScheduleReportButton')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mount(fetchImpl: () => Promise<Response>) {
  globalThis.fetch = (async () => fetchImpl()) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ScheduleReportButton definitionId="def-1" />
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

test('a refused schedules fetch shows the error with a retry, never stuck Loading (F1T-3)', async (t) => {
  const { host, root } = await mount(async () => Response.json({ error: 'unknown definition' }, { status: 404 }))
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    findButton(host, 'Scheduled delivery').click()
    await tick()
    await tick()
    await tick()
    await tick()
  })
  const dialog = document.body
  assert.doesNotMatch(dialog.textContent ?? '', /Loading schedules/, 'the drawer must leave the loading state')
  assert.match(dialog.textContent ?? '', /unknown definition/, 'the refusal is named in the drawer')
  findButton(dialog, 'Retry')
})

test('retrying after a failure loads the editor (F1T-3)', async (t) => {
  let calls = 0
  const { host, root } = await mount(async () => {
    calls += 1
    if (calls === 1) return new Response('', { status: 502 })
    return Response.json({ schedules: [], canSchedule: true }, { status: 200 })
  })
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    findButton(host, 'Scheduled delivery').click()
    await tick()
    await tick()
    await tick()
    await tick()
  })
  assert.match(document.body.textContent ?? '', /Failed to load \(status 502\)/)
  await act(async () => {
    findButton(document.body, 'Retry').click()
    await tick()
    await tick()
    await tick()
    await tick()
  })
  assert.equal(calls, 2, 'retry refetches the schedules')
  assert.doesNotMatch(document.body.textContent ?? '', /Failed to load/, 'the error clears once loading succeeds')
})
