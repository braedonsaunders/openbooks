import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// F1-11 (record-state fetch failure hides the approval UI): the old hook
// mapped every refusal to null and swallowed the catch, so the header
// controls vanished silently on a pending document. A blocked endpoint must
// surface a named error state with a working retry instead.
const script = {
  mode: 'blocked' as 'blocked' | 'named-refusal' | 'healed' | 'no-state',
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
await bootJsdomEnvironment({ url: "http://localhost:4800/entities/vendors" });

stubModules({ navigation: { source: 'export function useRouter(){return globalThis.__approvalLoadRouter}' }, intl: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(){},info(){}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

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
    if (script.mode === 'no-state') return Response.json({ error: 'not_found' }, { status: 404 })
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

test('a record with no approval state for the caller shows no raw refusal code', async (t) => {
  script.mode = 'no-state'
  const header = await mount(<ApprovalActions subjectKind="bill" subjectId="bill-5" />)
  await unmount(t, header.host, header.root)
  assert.equal(header.host.textContent, '', 'the header controls render nothing')

  const inline = await mount(<ApprovalHistory subjectKind="bill" subjectId="bill-6" />)
  await unmount(t, inline.host, inline.root)
  assert.equal(inline.host.textContent, '', 'an inline history section renders nothing')

  const tab = await mount(<ApprovalHistory subjectKind="bill" subjectId="bill-7" showEmptyState />)
  await unmount(t, tab.host, tab.root)
  const text = tab.host.textContent ?? ''
  assert.ok(!text.includes('not_found'), `never the raw code, got: ${JSON.stringify(text)}`)
  assert.ok(!/retry/i.test(text), 'no retry for an answer retrying cannot change')
  assert.ok(
    text.includes((messages as { common: { approvalFlow: { historyEmpty: string } } }).common.approvalFlow.historyEmpty),
    `the Approvals tab shows its empty body, got: ${JSON.stringify(text)}`,
  )
})
