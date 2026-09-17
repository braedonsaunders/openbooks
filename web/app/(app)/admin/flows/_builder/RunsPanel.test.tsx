import assert from 'node:assert/strict'
import test from 'node:test'

// F-t04-004: the flow Runs tab is read-only — a failed run shows its error
// but offers no path to re-drive it. Failed rows must offer a Retry that
// POSTs the runs retry endpoint and toasts the outcome.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/admin/flows/flow-1',
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

const script = {
  toasts: [] as Array<{ kind: string; message: string }>,
  retryPosts: [] as string[],
  retryStatus: 200 as number,
}
Object.assign(globalThis, {
  __runsRetryToasts: script.toasts,
  __runsRetryRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__runsRetryRouter}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__runsRetryToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__runsRetryToasts.push({kind:"error",message:String(m)})}};export function Toaster(){return null}',
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
const { RunsPanel } = await import('./RunsPanel')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const RUN_ID = '019f0000-0000-4000-8000-000000000007'

const runs = [
  {
    id: RUN_ID,
    subject_kind: 'party_bank_account',
    subject_id: 'acc-7',
    trigger: 'on_create',
    status: 'failed',
    error: 'gate (gate "Approval" resolved to zero assignees)',
    started_at: '2026-09-10T12:00:00.000Z',
    finished_at: '2026-09-10T12:00:01.000Z',
  },
  {
    id: '019f0000-0000-4000-8000-000000000008',
    subject_kind: 'party_bank_account',
    subject_id: 'acc-8',
    trigger: 'on_create',
    status: 'waiting',
    error: null,
    started_at: '2026-09-10T12:05:00.000Z',
    finished_at: null,
  },
]

async function mount() {
  script.toasts.length = 0
  script.retryPosts.length = 0
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url)
    script.retryPosts.push(href)
    if (script.retryStatus === 200) return Response.json({ runId: RUN_ID, status: 'waiting', gatesCreated: 1 })
    return Response.json({ error: 'only the latest run for this record can be retried' }, { status: 422 })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <RunsPanel runs={runs} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return { host, root }
}

function retryButtons() {
  return [...document.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === 'Retry',
  ) as HTMLButtonElement[]
}

test('only failed runs offer retry, and retry re-drives the run (F-t04-004)', async (t) => {
  script.retryStatus = 200
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  assert.equal(retryButtons().length, 1, 'exactly the failed row must offer Retry')
  await act(async () => {
    retryButtons()[0]!.click()
    await tick()
    await tick()
  })
  assert.deepEqual(script.retryPosts, [`/api/flows/runs/${RUN_ID}/retry`])
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success'),
    `the retry must toast success, got ${JSON.stringify(script.toasts)}`,
  )
})

test('a refused retry surfaces the typed reason (F-t04-004)', async (t) => {
  script.retryStatus = 422
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  await act(async () => {
    retryButtons()[0]!.click()
    await tick()
    await tick()
  })
  const errors = script.toasts.filter((toast) => toast.kind === 'error')
  assert.equal(errors.length, 1, 'a refused retry must toast once')
  assert.match(errors[0]!.message, /only the latest run/)
})
