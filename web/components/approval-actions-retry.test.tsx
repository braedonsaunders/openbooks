import assert from 'node:assert/strict'
import test from 'node:test'

// F-t04-004 (bank accounts stuck Pending on a failed flow run): the row
// offers Approve/Reject only while a live gate exists — a run that failed
// (gate resolved to zero assignees) leaves zero actions and no path to
// re-drive the gate. Record state must surface the latest failed run and
// the row must offer a Retry that POSTs the new runs retry endpoint.
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:4800/entities/vendors',
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
  canRetry: true,
}
Object.assign(globalThis, {
  __approvalRetryToasts: script.toasts,
  __approvalRetryRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__approvalRetryRouter}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__approvalRetryToasts.push({kind:"success",message:String(m)})},error(m){globalThis.__approvalRetryToasts.push({kind:"error",message:String(m)})},info(m){globalThis.__approvalRetryToasts.push({kind:"info",message:String(m)})}};export function Toaster(){return null}',
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
const messages = (await import('../messages/en')).default
const { ApprovalActions } = await import('./approval-actions')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const RUN_ID = '019f0000-0000-4000-8000-000000000009'

async function mount() {
  script.toasts.length = 0
  script.retryPosts.length = 0
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url)
    if (href.includes('/api/flows/record-state')) {
      return Response.json({
        approvalState: { status: 'pending', pendingWith: [], myActions: null },
        history: [],
        failedRun: {
          id: RUN_ID,
          error: 'gate (gate "Approval" resolved to zero assignees)',
          at: '2026-09-10T12:00:00.000Z',
        },
        canRetry: script.canRetry,
      })
    }
    if (href.includes('/api/flows/runs/') && href.endsWith('/retry')) {
      script.retryPosts.push(href)
      return Response.json({ runId: RUN_ID, status: 'waiting', gatesCreated: 1 })
    }
    throw new Error(`unexpected fetch ${href}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalActions subjectKind="party_bank_account" subjectId="acc-9" />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

test('a failed run surfaces a row-level retry that re-drives it (F-t04-004)', async (t) => {
  script.canRetry = true
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const retry = [...host.querySelectorAll('button')].find(
    (b) => /retry/i.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined
  assert.ok(retry, 'a failed run must offer a row-level retry')
  await act(async () => {
    retry.click()
    await tick()
    await tick()
  })
  assert.deepEqual(script.retryPosts, [`/api/flows/runs/${RUN_ID}/retry`])
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success'),
    `the retry must toast success, got ${JSON.stringify(script.toasts)}`,
  )
})

test('no retry without the flows-manage capability (F-t04-004)', async (t) => {
  script.canRetry = false
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const retry = [...host.querySelectorAll('button')].find(
    (b) => /retry/i.test(b.textContent ?? ''),
  )
  assert.equal(retry, undefined, 'a viewer without flows.manage must not see retry')
})
