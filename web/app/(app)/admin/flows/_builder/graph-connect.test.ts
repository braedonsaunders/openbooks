import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConnectEdge,
  connectHandles,
  connectTargets,
  type FlowNode,
} from './graph'

// Pure unit suite for the single keyboard/pointer edge path
// (web/app/(app)/admin/flows/_builder/graph.ts): what each kind can
// connect from, which successors the picker may offer, and what the
// shared builder accepts or refuses.

const LABELS = { then: 'then', else: 'else', approve: 'approve', reject: 'reject' }

function node(id: string, kind: FlowNode['data']['kind']): FlowNode {
  const data = {
    trigger: { kind: 'trigger', trigger: { trigger: 'manual', buttonId: 'btn', label: 'Run' } },
    condition: { kind: 'condition', rule: { op: 'isSet', field: 'status' } },
    action: { kind: 'action', action: { action: 'notify', to: [{ type: 'submitter' }], title: 'Hi' } },
    gate: {
      kind: 'gate',
      gate: { title: 'Approval', assignees: [{ type: 'role', role: 'approver' }], mode: 'any' },
    },
  }[kind] as FlowNode['data']
  return { id, position: { x: 0, y: 0 }, data }
}

const NODES = [node('t', 'trigger'), node('c', 'condition'), node('a', 'action'), node('g', 'gate')]

test('each kind exposes exactly the handles the canvas renders', () => {
  assert.deepEqual(connectHandles('trigger'), ['next'])
  assert.deepEqual(connectHandles('action'), ['next'])
  assert.deepEqual(connectHandles('condition'), ['then', 'else'])
  assert.deepEqual(connectHandles('gate'), ['approve', 'reject'])
})

test('the picker offers every step except the source and triggers', () => {
  // Triggers render no target handle: wiring into one would be a dead edge
  // the pointer path cannot even draw.
  assert.deepEqual(
    connectTargets('t', NODES).map((n) => n.id),
    ['c', 'a', 'g'],
  )
  assert.deepEqual(
    connectTargets('a', NODES).map((n) => n.id),
    ['c', 'a', 'g'].filter((id) => id !== 'a'),
  )
  assert.deepEqual(connectTargets('only', [node('only', 'trigger')]), [])
})

test('a keyboard connect builds the same edge a drag would', () => {
  const edge = buildConnectEdge({ source: 't', sourceHandle: 'next', target: 'a' }, NODES, LABELS)
  assert.ok(edge)
  assert.equal(edge.source, 't')
  assert.equal(edge.target, 'a')
  assert.equal(edge.sourceHandle, 'next')
  assert.equal(edge.label, undefined)

  const branch = buildConnectEdge({ source: 'c', sourceHandle: 'else', target: 'g' }, NODES, LABELS)
  assert.ok(branch)
  assert.equal(branch?.sourceHandle, 'else')
  assert.equal(branch?.label, 'else')
})

test('an invalid connect builds nothing', () => {
  // Self-connect.
  assert.equal(buildConnectEdge({ source: 'a', sourceHandle: 'next', target: 'a' }, NODES, LABELS), null)
  // Into a trigger (no target handle exists there).
  assert.equal(buildConnectEdge({ source: 'a', sourceHandle: 'next', target: 't' }, NODES, LABELS), null)
  // A handle the source kind does not expose.
  assert.equal(buildConnectEdge({ source: 't', sourceHandle: 'then', target: 'a' }, NODES, LABELS), null)
  // Unknown ids.
  assert.equal(buildConnectEdge({ source: 'ghost', sourceHandle: 'next', target: 'a' }, NODES, LABELS), null)
  assert.equal(buildConnectEdge({ source: 't', sourceHandle: 'next', target: 'ghost' }, NODES, LABELS), null)
})
