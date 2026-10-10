const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return { refresh(){} }}' })
import assert from 'node:assert/strict'
import test from 'node:test'

const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/flows/flow-1', scrollIntoView: false })
// The designer's dark-theme sync observes documentElement class changes.
if (typeof (globalThis as Record<string, unknown>).MutationObserver === 'undefined') {
  Object.assign(globalThis, { MutationObserver: (window as unknown as { MutationObserver: unknown }).MutationObserver })
}

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { default: FlowBuilder } = await import('./FlowBuilder')
import type { AutomationGraph, FlowSubjectProfile } from '@openbooks/forms-core'

const profile: FlowSubjectProfile = {
  subjectKind: 'estimate',
  label: 'Estimate',
  triggers: ['on_submit', 'manual'],
  actions: ['notify'],
  statuses: [],
  fields: [{ key: 'total', label: 'Total', type: 'number' }],
  roles: ['approver'],
}

function wiredGraph(): AutomationGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 't1', position: { x: 60, y: 120 }, data: { kind: 'trigger', trigger: { trigger: 'on_submit' } } },
      {
        id: 'a1',
        position: { x: 320, y: 120 },
        data: { kind: 'action', action: { action: 'notify', to: [{ type: 'submitter' }], title: 'Hi' } },
      },
    ],
    edges: [{ id: 'e1', source: 't1', target: 'a1', sourceHandle: 'next' }],
  }
}

function emptyConditionGraph(): AutomationGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 't1', position: { x: 60, y: 120 }, data: { kind: 'trigger', trigger: { trigger: 'on_submit' } } },
      {
        id: 'cond_1',
        position: { x: 320, y: 120 },
        data: { kind: 'condition', label: 'Total check', rule: { op: 'and', rules: [] } },
      },
    ],
    edges: [{ id: 'e1', source: 't1', target: 'cond_1', sourceHandle: 'next' }],
  }
}

type FetchCall = { url: string; init: RequestInit }
type FetchResponder = (call: FetchCall) => unknown

function stubFetch(responder: FetchResponder): FetchCall[] {
  const calls: FetchCall[] = []
  const fetchStub = async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    const body = responder(call)
    return { ok: true, status: 200, json: async () => body }
  }
  Object.assign(globalThis, { fetch: fetchStub })
  return calls
}

function renderBuilder(flow: { enabled: boolean; graph: AutomationGraph }): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <FlowBuilder
          flow={{ id: 'flow-1', name: 'Estimate flow', enabled: flow.enabled, updatedAt: 'rev-1', graph: flow.graph }}
          runs={[]}
          profile={profile}
          users={[]}
          roles={[{ key: 'approver', name: 'Approver' }]}
          permissions={[]}
        />
      </NextIntlClientProvider>,
    )
  })
  return host
}

function enabledSwitch(host: HTMLElement): HTMLElement {
  const toggles = [...host.querySelectorAll('[role="switch"]')]
  const toggle = toggles[0]
  assert.ok(toggle, 'expected the Enabled switch')
  return toggle as HTMLElement
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test('the Enabled toggle persists through the flag-only save path', async () => {
  const calls = stubFetch(() => ({ ok: true, warnings: [], updatedAt: 'rev-2', enabled: true }))
  const host = renderBuilder({ enabled: false, graph: wiredGraph() })
  try {
    const toggle = enabledSwitch(host)
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    act(() => {
      toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await flush()
    assert.equal(calls.length, 1, `one save request expected, got ${calls.length}`)
    assert.ok(calls[0]?.url.endsWith('/api/admin/flows/flow-1'), `PATCH targets the flow, got ${calls[0]?.url}`)
    const body = JSON.parse(String(calls[0]?.init.body))
    assert.equal(body.enabled, true)
    assert.equal(body.expectedUpdatedAt, 'rev-1')
    assert.ok(!('graph' in body), `the toggle must not bundle the canvas, got keys ${Object.keys(body).join(',')}`)
    assert.equal(enabledSwitch(host).getAttribute('aria-checked'), 'true', 'the switch renders the stored state')
  } finally {
    host.remove()
  }
})

test('the switch follows the persisted flag over the optimistic copy', async () => {
  // The server resolves the write as still disabled (a concurrent change);
  // the designer must show the stored state, not the click.
  stubFetch(() => ({ ok: true, warnings: [], updatedAt: 'rev-2', enabled: false }))
  const host = renderBuilder({ enabled: false, graph: wiredGraph() })
  try {
    act(() => {
      enabledSwitch(host).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await flush()
    assert.equal(enabledSwitch(host).getAttribute('aria-checked'), 'false')
  } finally {
    host.remove()
  }
})

test('the palette blocks a second trigger while one exists', () => {
  stubFetch(() => ({}))
  const withTrigger = renderBuilder({ enabled: false, graph: wiredGraph() })
  try {
    const addTrigger = [...withTrigger.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Trigger') && b.closest('.absolute'),
    )
    assert.ok(addTrigger, 'expected a palette Trigger button')
    assert.equal((addTrigger as HTMLButtonElement).disabled, true, 'the trigger button is blocked')
  } finally {
    withTrigger.remove()
  }
  const empty = renderBuilder({
    enabled: false,
    graph: { schemaVersion: 1, nodes: [], edges: [] },
  })
  try {
    const addTrigger = [...empty.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Trigger') && b.closest('.absolute'),
    )
    assert.ok(addTrigger, 'expected a palette Trigger button')
    assert.equal((addTrigger as HTMLButtonElement).disabled, false, 'the first trigger is always allowed')
  } finally {
    empty.remove()
  }
})

test('fire-readiness banners name the state, never a storage id', () => {
  stubFetch(() => ({}))
  const disabled = renderBuilder({ enabled: false, graph: wiredGraph() })
  try {
    assert.match(
      disabled.textContent ?? '',
      /will not run while it is disabled/,
      'a disabled flow says it will not run',
    )
  } finally {
    disabled.remove()
  }
  const incomplete = renderBuilder({ enabled: true, graph: emptyConditionGraph() })
  try {
    const text = incomplete.textContent ?? ''
    assert.match(text, /Incomplete:/, `an unfireable flow reads Incomplete, got: ${text.slice(0, 200)}`)
    assert.match(text, /Total check/, 'the empty condition is named by its label')
    assert.ok(!text.includes('cond_1'), 'no storage id may appear in the banner')
  } finally {
    incomplete.remove()
  }
})
