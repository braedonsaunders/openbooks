import assert from 'node:assert/strict'
import test from 'node:test'

// F1 (flow builder keyboard connect): a Trigger + Approval pair must be
// connectable without pointer events. The inspector's "Connect to next
// step" section picks a successor and calls the same onConnect the canvas
// drop path uses — this test drives that section with keyboard-equivalent
// DOM events only (change + click, never a drag) and asserts the request
// it emits, which targets are offered, and how nodes are named.
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
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (() => ({
    matches: true,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia
}
if (typeof (globalThis as Record<string, unknown>).ResizeObserver !== 'function') {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { Inspector } = await import('./Inspector')
const { nodeAccessibleName } = await import('./nodes')
import type { FlowSubjectProfile } from '@openbooks/forms-core'
import type { ConnectRequest, FlowNode } from './graph'

const profile: FlowSubjectProfile = {
  subjectKind: 'test',
  label: 'Test',
  triggers: ['manual', 'on_submit'],
  actions: ['notify'],
  statuses: [],
  fields: [],
  roles: ['approver'],
}

const triggerNode: FlowNode = {
  id: 't',
  position: { x: 0, y: 0 },
  data: { kind: 'trigger', trigger: { trigger: 'manual', buttonId: 'btn_1', label: 'Run flow' } },
}
const gateNode: FlowNode = {
  id: 'g',
  position: { x: 260, y: 0 },
  data: {
    kind: 'gate',
    gate: { title: 'Manager sign-off', assignees: [{ type: 'role', role: 'approver' }], mode: 'any' },
  },
}
const otherTrigger: FlowNode = {
  id: 't2',
  position: { x: 0, y: 160 },
  data: { kind: 'trigger', trigger: { trigger: 'on_submit' } },
}

function renderInspector(nodes: FlowNode[], onConnect: (req: ConnectRequest) => boolean): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Inspector
          node={triggerNode}
          nodes={nodes}
          profile={profile}
          users={[]}
          roles={[{ key: 'approver', name: 'Approver' }]}
          permissions={[]}
          onChange={() => {}}
          onDelete={() => {}}
          onConnect={onConnect}
        />
      </NextIntlClientProvider>,
    )
  })
  return host
}

function selectByLabel(host: HTMLElement, label: string): HTMLSelectElement {
  const labels = [...host.querySelectorAll('label')]
  const match = labels.find((el) => el.textContent?.trim() === label)
  assert.ok(match, `expected a "${label}" label`)
  // The house Label wraps the text in a span (with a help button), so walk
  // up to the field container holding the select.
  let container = match!.parentElement
  while (container && !container.querySelector('select')) container = container.parentElement
  const select = container?.querySelector('select')
  assert.ok(select, `expected a select under "${label}"`)
  return select as HTMLSelectElement
}

test('node accessible names carry kind plus label', () => {
  const lookup = (key: string): string => {
    const parts = key.split('.')
    let cur: unknown = messages.admin.flows
    for (const part of parts) cur = (cur as Record<string, unknown>)[part]
    return String(cur)
  }
  assert.equal(nodeAccessibleName(lookup, triggerNode.data), 'Trigger: A user clicks a button')
  assert.equal(nodeAccessibleName(lookup, gateNode.data), 'Approval: Manager sign-off')
  assert.equal(
    nodeAccessibleName(lookup, { kind: 'condition', rule: { op: 'isSet', field: 'status' } }),
    'Condition: If…',
  )
  assert.equal(
    nodeAccessibleName(lookup, {
      kind: 'action',
      action: { action: 'notify', to: [{ type: 'submitter' }], title: 'Update' },
    }),
    'Action: Update',
  )
})

test('keyboard connect wires trigger to approval without pointer events', () => {
  const calls: ConnectRequest[] = []
  const host = renderInspector([triggerNode, gateNode, otherTrigger], (req) => {
    calls.push(req)
    return true
  })
  try {
    const options = [...selectByLabel(host, 'To step').querySelectorAll('option')].map((o) => ({
      value: o.value,
      label: o.textContent?.trim(),
    }))
    // The picker offers the approval by its accessible name, and never the
    // source itself nor the other trigger (triggers expose no target).
    assert.ok(
      options.some((o) => o.value === 'g' && o.label === 'Approval: Manager sign-off'),
      `approval must be offered by name, got: ${JSON.stringify(options)}`,
    )
    assert.ok(!options.some((o) => o.value === 't'), 'the source must not be offered')
    assert.ok(!options.some((o) => o.value === 't2'), 'triggers must not be offered as targets')

    const target = selectByLabel(host, 'To step')
    act(() => {
      target.value = 'g'
      target.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    const connect = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Connect')
    assert.ok(connect, 'expected a Connect button')
    act(() => {
      connect!.click()
    })
    assert.deepEqual(calls, [{ source: 't', sourceHandle: 'next', target: 'g' }])
    // The picker resets for the next connection.
    assert.equal(selectByLabel(host, 'To step').value, '')
  } finally {
    host.remove()
  }
})

test('a refused connect keeps the picker selection', () => {
  const calls: ConnectRequest[] = []
  const host = renderInspector([triggerNode, gateNode], (req) => {
    calls.push(req)
    return false
  })
  try {
    const target = selectByLabel(host, 'To step')
    act(() => {
      target.value = 'g'
      target.dispatchEvent(new window.Event('change', { bubbles: true }))
    })
    const connect = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Connect')
    act(() => {
      connect!.click()
    })
    assert.deepEqual(calls, [{ source: 't', sourceHandle: 'next', target: 'g' }])
    assert.equal(selectByLabel(host, 'To step').value, 'g', 'a refused request must not drop the selection')
  } finally {
    host.remove()
  }
})

test('a lone trigger explains that no step exists yet', () => {
  const host = renderInspector([triggerNode], () => true)
  try {
    assert.match(
      host.textContent ?? '',
      /no other step yet/,
      'the connect section must say why there is nothing to pick',
    )
  } finally {
    host.remove()
  }
})
