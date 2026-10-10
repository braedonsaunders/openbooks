import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canAddTrigger,
  dedupeGraphNodes,
  fromFlow,
  toFlow,
  type FlowNode,
} from './graph'
import type { AutomationGraph } from '@openbooks/forms-core'

// Loading and saving a flow graph is idempotent: a stored graph that somehow
// carries two nodes with one storage id loads as one, and a save never
// writes duplicates — re-open → save converges instead of growing.

const LABELS = { then: 'then', else: 'else', approve: 'approve', reject: 'reject' }

function triggerNode(id: string): FlowNode {
  return {
    id,
    position: { x: 60, y: 120 },
    data: { kind: 'trigger', trigger: { trigger: 'on_submit' } },
  }
}

function conditionNode(id: string, y: number): FlowNode {
  return {
    id,
    position: { x: 320, y },
    data: { kind: 'condition', label: 'Big orders', rule: { op: 'isSet', field: 'total' } },
  }
}

function storedGraph(): AutomationGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 't', position: { x: 60, y: 120 }, data: { kind: 'trigger', trigger: { trigger: 'on_submit' } } },
    ],
    edges: [],
  }
}

test('loading drops duplicated storage ids, keeping the first occurrence', () => {
  const duplicated: AutomationGraph = {
    schemaVersion: 1,
    nodes: [
      { id: 't', position: { x: 60, y: 120 }, data: { kind: 'trigger', trigger: { trigger: 'on_submit' } } },
      { id: 'c', position: { x: 320, y: 120 }, data: { kind: 'condition', label: 'First', rule: { op: 'isSet', field: 'total' } } },
      { id: 'c', position: { x: 320, y: 280 }, data: { kind: 'condition', label: 'Second', rule: { op: 'isSet', field: 'total' } } },
    ],
    edges: [{ id: 'e', source: 't', target: 'c', sourceHandle: 'next' }],
  }
  const deduped = dedupeGraphNodes(duplicated)
  assert.deepEqual(deduped.nodes.map((n) => n.id), ['t', 'c'])
  assert.equal(
    (deduped.nodes[1]?.data as { label?: string }).label,
    'First',
    'the first occurrence wins so canvas order is stable',
  )
  const { nodes } = toFlow(duplicated, LABELS)
  assert.deepEqual(nodes.map((n) => n.id), ['t', 'c'])
})

test('a graph without duplicates loads untouched', () => {
  const graph = storedGraph()
  assert.equal(dedupeGraphNodes(graph), graph, 'no copy when there is nothing to drop')
})

test('a load → save round trip is stable and never grows nodes', () => {
  const graph = storedGraph()
  const first = toFlow(graph, LABELS)
  const saved = fromFlow(first.nodes, first.edges)
  assert.deepEqual(saved.nodes.map((n) => n.id), ['t'])
  // Saving the saved graph again changes nothing.
  const second = toFlow(saved, LABELS)
  assert.deepEqual(
    fromFlow(second.nodes, second.edges),
    saved,
    'the second round trip must equal the first',
  )
  // Even canvas state holding a duplicated id persists as one node.
  const canvas = [triggerNode('t'), conditionNode('c', 120), conditionNode('c', 280)]
  const persisted = fromFlow(canvas, [])
  assert.deepEqual(persisted.nodes.map((n) => n.id), ['t', 'c'])
})

test('a second trigger cannot be added while one exists', () => {
  assert.equal(canAddTrigger([]), true)
  assert.equal(canAddTrigger([conditionNode('c', 120)]), true)
  assert.equal(canAddTrigger([triggerNode('t')]), false)
  assert.equal(canAddTrigger([triggerNode('t'), conditionNode('c', 120)]), false)
})
