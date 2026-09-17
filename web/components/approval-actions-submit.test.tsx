import assert from 'node:assert/strict'
import test from 'node:test'

// F-t04-004 residual (bank accounts stranded with NO flow run at all): the
// row claims "Pending approval" while the engine never saw the record, so
// the drawer must offer to submit it into the current flow. Record state
// reports neverSubmitted for that case; the row renders a Submit button
// only when the surface passes an explicit submit href (parties bank panel),
// and the submit POSTs it, toasts, and refreshes the approval state.
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
  submitPosts: [] as string[],
  submitHref: '/api/parties/party-1/bank-accounts/submit?accountId=acc-9' as string | undefined,
}
Object.assign(globalThis, {
  __approvalSubmitToasts: script.toasts,
  __approvalSubmitRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__approvalSubmitRouter}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(m){globalThis.__approvalSubmitToasts.push({kind:\"success\",message:String(m)})},error(m){globalThis.__approvalSubmitToasts.push({kind:\"error\",message:String(m)})},info(m){globalThis.__approvalSubmitToasts.push({kind:\"info\",message:String(m)})}};export function Toaster(){return null}',
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

async function mount() {
  script.toasts.length = 0
  script.submitPosts.length = 0
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    const href = String(url)
    if (href.includes('/api/flows/record-state')) {
      return Response.json({
        approvalState: { status: 'pending', pendingWith: [], myActions: null },
        history: [],
        failedRun: null,
        canRetry: false,
        neverSubmitted: true,
      })
    }
    if (href === script.submitHref && (init?.method ?? 'GET') === 'POST') {
      script.submitPosts.push(href)
      return Response.json({ id: 'acc-9', approvalStatus: 'pending', runId: 'run-1', gatesCreated: 1 })
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${href}`)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ApprovalActions subjectKind="party_bank_account" subjectId="acc-9" submitApprovalHref={script.submitHref} />
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

test('a never-submitted record offers a row-level submit into the flow (F-t04-004 residual)', async (t) => {
  script.submitHref = '/api/parties/party-1/bank-accounts/submit?accountId=acc-9'
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const submit = [...host.querySelectorAll('button')].find(
    (b) => /submit/i.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined
  assert.ok(submit, 'a never-submitted record must offer a row-level submit')
  await act(async () => {
    submit.click()
    await tick()
    await tick()
  })
  assert.deepEqual(script.submitPosts, [script.submitHref])
  assert.ok(
    script.toasts.some((toast) => toast.kind === 'success'),
    `the submit must toast success, got ${JSON.stringify(script.toasts)}`,
  )
})

test('no submit affordance without an explicit submit href (F-t04-004 residual)', async (t) => {
  script.submitHref = undefined
  const { host, root } = await mount()
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
  const submit = [...host.querySelectorAll('button')].find(
    (b) => /submit/i.test(b.textContent ?? ''),
  )
  assert.equal(submit, undefined, 'surfaces without a submit path must stay quiet')
})
