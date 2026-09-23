import type { Edge, Node } from '@xyflow/react'
import type {
  ActionData,
  ActionKind,
  AutomationGraph,
  AutomationNode,
  FlowSubjectProfile,
  TriggerData,
  TriggerKind,
} from '@openbooks/forms-core'

/**
 * Graph plumbing shared by the flow builder: AutomationGraph ⇄ React Flow
 * conversion, node-id minting, and profile-driven default node payloads.
 * Pure data — every React component lives beside this file.
 */

export type NodeData = AutomationNode['data']
export type NodeKind = NodeData['kind']
export type FlowNode = Node<NodeData>

/** An org user offered by the "specific user" pickers. */
export type OrgUser = { id: string; name: string; email: string }
export type OrgRole = { key: string; name: string }

export const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID()}`

/** Branch-handle → visible edge label ('next' stays unlabeled). */
export function edgeLabel(
  handle: string | null | undefined,
  labels: Record<string, string>,
): string | undefined {
  return handle && handle !== 'next' ? (labels[handle] ?? handle) : undefined
}

/** A keyboard/button connect request: source node + handle, target node. */
export interface ConnectRequest {
  source: string
  sourceHandle: string
  target: string
}

/**
 * Handles a node can connect FROM — exactly the source Handle ids the
 * canvas renders for the kind, so the button path can never offer a handle
 * the pointer path could not drop from.
 */
export function connectHandles(kind: NodeKind): string[] {
  switch (kind) {
    case 'trigger':
    case 'action':
      return ['next']
    case 'condition':
      return ['then', 'else']
    case 'gate':
      return ['approve', 'reject']
  }
}

/**
 * Valid keyboard/button successors for a source node: every node exposing a
 * target Handle (triggers render none, so wiring into one would be a dead
 * edge the pointer path cannot even draw), minus the source itself.
 */
export function connectTargets(sourceId: string, nodes: FlowNode[]): FlowNode[] {
  return nodes.filter((n) => n.id !== sourceId && n.data.kind !== 'trigger')
}

/**
 * THE single edge path: both the pointer onConnect and the inspector's
 * keyboard connect build through here. Returns null when the connection is
 * invalid (unknown ids, self-connect, a trigger target, or a handle the
 * source kind does not expose) so an invalid request adds nothing, dirties
 * nothing, and reports nothing as connected.
 */
export function buildConnectEdge(
  req: ConnectRequest,
  nodes: FlowNode[],
  labels: Record<string, string>,
): Edge | null {
  const source = nodes.find((n) => n.id === req.source)
  const target = nodes.find((n) => n.id === req.target)
  if (!source || !target) return null
  if (source.id === target.id) return null
  if (target.data.kind === 'trigger') return null
  if (!connectHandles(source.data.kind).includes(req.sourceHandle)) return null
  return {
    id: newId('e'),
    source: source.id,
    target: target.id,
    sourceHandle: req.sourceHandle,
    label: edgeLabel(req.sourceHandle, labels),
  }
}

/** Stored graph → React Flow state (labels re-derived from handles). */
export function toFlow(
  graph: AutomationGraph,
  labels: Record<string, string>,
): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: n.data.kind,
      position: n.position,
      data: n.data,
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      label: edgeLabel(e.sourceHandle, labels),
    })),
  }
}

/** React Flow state → the persisted AutomationGraph (positions rounded). */
export function fromFlow(nodes: FlowNode[], edges: Edge[]): AutomationGraph {
  return {
    schemaVersion: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      data: n.data,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: (e.sourceHandle as AutomationGraph['edges'][number]['sourceHandle']) ?? 'next',
    })),
  }
}

/**
 * Fresh TriggerData for a trigger kind. Defaults are chosen to pass the zod
 * graph schema so a just-added node can be saved immediately.
 */
export function buildTrigger(kind: TriggerKind, profile: FlowSubjectProfile): TriggerData {
  switch (kind) {
    case 'on_field_value':
      return { trigger: 'on_field_value', rule: { op: 'isSet', field: firstFieldKey(profile) } }
    case 'status_change':
      return { trigger: 'status_change' } // no from/to = every transition
    case 'scheduled':
      return { trigger: 'scheduled', cron: '0 8 * * 1' }
    case 'manual':
      return { trigger: 'manual', buttonId: newId('btn'), label: 'Run flow' }
    default:
      return { trigger: kind } as TriggerData
  }
}

/** Fresh ActionData for an action kind, again schema-valid out of the box. */
export function buildAction(kind: ActionKind, profile: FlowSubjectProfile): ActionData {
  switch (kind) {
    case 'send_email':
      return {
        action: 'send_email',
        to: [{ type: 'submitter' }],
        subject: 'Update on {{documentNumber}}',
        body: '',
      }
    case 'notify':
      return { action: 'notify', to: [{ type: 'submitter' }], title: 'Update on {{documentNumber}}' }
    case 'set_field':
      return {
        action: 'set_field',
        field: firstWritableFieldKey(profile),
        value: { kind: 'literal', value: '' },
      }
    case 'change_status':
      return { action: 'change_status', to: profile.statuses[0]?.value ?? 'draft' }
    case 'post_document':
      return { action: 'post_document' }
    case 'lock_record':
      return { action: 'lock_record' }
    case 'unlock_record':
      return { action: 'unlock_record' }
  }
}

/** Default payload for a node freshly dropped from the palette. */
export function defaultNodeData(kind: NodeKind, profile: FlowSubjectProfile): NodeData {
  switch (kind) {
    case 'trigger':
      return { kind: 'trigger', trigger: buildTrigger(profile.triggers[0] ?? 'on_submit', profile) }
    case 'condition':
      return { kind: 'condition', rule: { op: 'isSet', field: firstFieldKey(profile) } }
    case 'action':
      return { kind: 'action', action: buildAction(profile.actions[0] ?? 'notify', profile) }
    case 'gate':
      return {
        kind: 'gate',
        gate: {
          title: 'Approval',
          assignees: [{ type: 'role', role: profile.roles?.[0] ?? 'approver' }],
          mode: 'any',
        },
      }
  }
}

export function firstFieldKey(profile: FlowSubjectProfile): string {
  return profile.fields[0]?.key ?? 'status'
}

export function firstWritableFieldKey(profile: FlowSubjectProfile): string {
  return profile.fields.find((f) => f.writable)?.key ?? firstFieldKey(profile)
}

/**
 * Where a palette-added node lands: to the right of the current frontier,
 * lightly staggered vertically so stacks of adds stay readable. Triggers
 * start a column of their own on the left edge.
 */
export function nextPosition(kind: NodeKind, nodes: FlowNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 60, y: 120 }
  if (kind === 'trigger') {
    const triggers = nodes.filter((n) => n.data.kind === 'trigger')
    const maxY = triggers.length ? Math.max(...triggers.map((n) => n.position.y)) : -60
    return { x: 60, y: maxY + 160 }
  }
  const maxX = Math.max(...nodes.map((n) => n.position.x))
  const atFrontier = nodes.filter((n) => n.position.x === maxX)
  return { x: maxX + 260, y: (atFrontier[0]?.position.y ?? 120) + (atFrontier.length - 1) * 40 }
}
