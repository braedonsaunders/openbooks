import assert from 'node:assert/strict'
import test from 'node:test'

// F1-11 (record-state fetch failure hides the approval UI): the old hook
// mapped every refusal to null and swallowed the catch, so the header
// controls vanished silently on a pending document. A blocked endpoint must
// surface a named error state with a working retry instead.
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
  mode: 'blocked' as 'blocked' | 'named-refusal' | 'healed',
}
Object.assign(globalThis, {
  __approvalLoadRouter: {
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
        url: 'data:text/javascript,export function useRouter(){return globalThis.__approvalLoadRouter}',
      }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
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
const { ApprovalHistory } = await import('./approval-history')

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

function healedState() {
  return {
    approvalState: {
      status: 'pending',
      pendingWith: [],
      myActions: { gateId: 'gate-1', signatureRequired: false },
    },
    history: [],
    failedRun: null,
    canRetry: false,
  }
}

globalThis.fetch = (async (url: unknown) => {
  const href = String(url)
  if (href.includes('/api/flows/record-state')) {
    if (script.mode === 'healed') return Response.json(healedState())
    if (script.mode === 'named-refusal') {
      return Response.json({ error: 'flow pack retired — reinstall the pack' }, { status: 422 })
    }
    return new Response('<html><body>Bad Gateway</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    })
  }
  throw new Error(`unexpected fetch ${href}`)
}) as typeof fetch

async function mount(node: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </NextIntlClientProvider>,
    )
    await tick()
    await tick()
  })
  return { host, root }
}

async function unmount(t: test.TestContext, host: HTMLElement, root: { unmount(): void }) {
  t.after(async () => {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  })
}

test('a blocked record-state endpoint names the failure instead of vanishing (F1-11)', async (t) => {
  script.mode = 'blocked'
  const { host, root } = await mount(
    <ApprovalActions subjectKind="bill" subjectId="bill-1" />,
  )
  await unmount(t, host, root)
  assert.ok(
    host.textContent?.includes('Failed to load (status 502)'),
    `a pending doc must name the load failure, got: ${JSON.stringify(host.textContent)}`,
  )
  const retry = [...host.querySelectorAll('button')].find(
    (b) => /retry/i.test(b.textContent ?? ''),
  )
  assert.ok(retry, 'the named error must offer the retry remedy')
})

test('a JSON refusal surfaces the server message (F1-11)', async (t) => {
  script.mode = 'named-refusal'
  const { host, root } = await mount(
    <ApprovalActions subjectKind="bill" subjectId="bill-2" />,
  )
  await unmount(t, host, root)
  assert.ok(
    host.textContent?.includes('flow pack retired'),
    `the server refusal must reach the operator, got: ${JSON.stringify(host.textContent)}`,
  )
})

test('retry re-runs the load and restores the live controls (F1-11)', async (t) => {
  script.mode = 'blocked'
  const { host, root } = await mount(
    <ApprovalActions subjectKind="bill" subjectId="bill-3" />,
  )
  await unmount(t, host, root)
  const retry = [...host.querySelectorAll('button')].find(
    (b) => /retry/i.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined
  assert.ok(retry, 'precondition: the blocked load must offer retry')
  script.mode = 'healed'
  await act(async () => {
    retry.click()
    await tick()
    await tick()
  })
  const approve = [...host.querySelectorAll('button')].find(
    (b) => /approve/i.test(b.textContent ?? ''),
  )
  assert.ok(approve, `retry must restore the live Approve control, got: ${JSON.stringify(host.textContent)}`)
})

test('the history tab names a failed load instead of spinning forever (F1-11)', async (t) => {
  script.mode = 'blocked'
  const { host, root } = await mount(
    <ApprovalHistory subjectKind="bill" subjectId="bill-4" showEmptyState />,
  )
  await unmount(t, host, root)
  assert.ok(
    host.textContent?.includes('Failed to load (status 502)'),
    `the tab must name the failure, got: ${JSON.stringify(host.textContent)}`,
  )
})
