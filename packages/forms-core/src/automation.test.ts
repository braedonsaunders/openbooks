// Run with:  node --import tsx --test packages/forms-core/src/automation.test.ts
//
// Planner + lint tests for the pure flow-graph core, ported from
// beaconhs-platform's automation.test.ts and adapted to the openbooks
// trigger/action vocabulary.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  automationGraphSchema,
  gateDataSchema,
  interpolateTemplate,
  lintAutomationGraph,
  lintWorkerTriggerCompatibility,
  planAutomation,
  planFromGate,
  type ActionData,
  type AutomationGraph,
  type TriggerData,
  type TriggerEvent,
} from './automation'
import type { FlowSubjectProfile } from './flow-subjects'
import type { EvalContext } from './evaluator'

const emptyCtx: EvalContext = { values: {}, rows: {} }

function notify(title: string): ActionData {
  return { action: 'notify', to: [{ type: 'submitter' }], title }
}

function schedGraphWith(data: AutomationGraph['nodes'][number]['data']): AutomationGraph {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: 'trigger',
        position: { x: 0, y: 0 },
        data: { kind: 'trigger', trigger: { trigger: 'scheduled', cron: '* * * * *' } },
      },
      { id: 'node', position: { x: 100, y: 0 }, data },
    ],
    edges: [{ id: 'edge', source: 'trigger', target: 'node', sourceHandle: 'next' }],
  }
}

/**
 * Build a graph where each entry pairs a trigger with a single notify action
 * wired straight off it, so `planAutomation` output can be asserted by the
 * collected notification titles.
 */
function graphOf(triggers: Array<{ trigger: TriggerData; title: string }>): AutomationGraph {
  const nodes: AutomationGraph['nodes'] = []
  const edges: AutomationGraph['edges'] = []
  triggers.forEach(({ trigger, title }, i) => {
    const tId = `t${i}`
    const aId = `a${i}`
    nodes.push({ id: tId, position: { x: 0, y: i * 100 }, data: { kind: 'trigger', trigger } })
    nodes.push({
      id: aId,
      position: { x: 200, y: i * 100 },
      data: { kind: 'action', action: notify(title) },
    })
    edges.push({ id: `e${i}`, source: tId, target: aId, sourceHandle: 'next' })
  })
  return { schemaVersion: 1, nodes, edges }
}

function titles(
  graph: AutomationGraph,
  event: TriggerEvent,
  ctx: EvalContext,
  opts?: { triggerNodeIds?: string[] },
): string[] {
  return planAutomation(graph, event, ctx, opts).actions.flatMap((a) =>
    a.action === 'notify' ? [a.title] : [],
  )
}

// --- Schemas -----------------------------------------------------------------

describe('graph schema', () => {
  test('parses a full trigger→condition→gate→action graph', () => {
    const graph: AutomationGraph = {
      schemaVersion: 1,
      nodes: [
        {
          id: 't',
          position: { x: 0, y: 0 },
          data: { kind: 'trigger', trigger: { trigger: 'on_submit' } },
        },
        {
          id: 'c',
          position: { x: 100, y: 0 },
          data: { kind: 'condition', rule: { op: 'gt', field: 'total', value: 1000 } },
        },
        {
          id: 'g',
          position: { x: 200, y: 0 },
          data: {
            kind: 'gate',
            gate: {
              title: 'Manager approval',
              assignees: [{ type: 'supervisor' }, { type: 'role', role: 'controller' }],
              mode: 'any',
              reminderAfterHours: 24,
              escalateAfterHours: 72,
              escalateTo: { type: 'role', role: 'admin' },
            },
          },
        },
        {
          id: 'a',
          position: { x: 300, y: 0 },
          data: { kind: 'action', action: { action: 'change_status', to: 'approved' } },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'c', sourceHandle: 'next' },
        { id: 'e2', source: 'c', target: 'g', sourceHandle: 'then' },
        { id: 'e3', source: 'g', target: 'a', sourceHandle: 'approve' },
      ],
    }
    assert.deepEqual(automationGraphSchema.parse(graph), graph)
  })

  test('a gate requires at least one assignee', () => {
    assert.throws(() =>
      gateDataSchema.parse({ title: 'Approval', assignees: [], mode: 'all' }),
    )
  })

  test('gate preventSelfApproval is optional and backward-compatible', () => {
    const base = { title: 'Approval', assignees: [{ type: 'supervisor' }], mode: 'any' }
    // Existing graphs (no flag) still parse, and the flag stays absent.
    assert.equal(gateDataSchema.parse(base).preventSelfApproval, undefined)
    assert.equal(
      gateDataSchema.parse({ ...base, preventSelfApproval: true }).preventSelfApproval,
      true,
    )
    assert.throws(() => gateDataSchema.parse({ ...base, preventSelfApproval: 'yes' }))
  })
})

// --- {{field}} interpolation ---------------------------------------------------

describe('interpolateTemplate', () => {
  test('substitutes header values and blanks unknown fields', () => {
    const ctx: EvalContext = { values: { docNumber: 'INV-042', total: 1250.5 }, rows: {} }
    assert.equal(
      interpolateTemplate('Invoice {{docNumber}} for {{ total }} ({{missing}})', ctx),
      'Invoice INV-042 for 1250.5 ()',
    )
  })
})

// --- Engine planning -----------------------------------------------------------

describe('planAutomation', () => {
  test('plans EVERY on_field_value trigger whose rule passes, not just the first', () => {
    const graph = graphOf([
      {
        trigger: { trigger: 'on_field_value', rule: { op: 'eq', field: 'a', value: 'no' } },
        title: 'first',
      },
      {
        trigger: { trigger: 'on_field_value', rule: { op: 'eq', field: 'a', value: 'yes' } },
        title: 'second',
      },
    ])
    const ctx: EvalContext = { values: { a: 'yes' }, rows: {} }
    // The FIRST trigger's rule fails; the second must still fire.
    assert.deepEqual(titles(graph, { kind: 'on_field_value' }, ctx), ['second'])
  })

  test('collects branches from multiple satisfied triggers', () => {
    const graph = graphOf([
      { trigger: { trigger: 'on_submit' }, title: 'one' },
      { trigger: { trigger: 'on_submit' }, title: 'two' },
    ])
    assert.deepEqual(titles(graph, { kind: 'on_submit' }, emptyCtx).sort(), ['one', 'two'])
  })

  test('status_change honors the trigger `to` and `from` filters', () => {
    const graph = graphOf([
      {
        trigger: { trigger: 'status_change', from: 'pending_approval', to: 'approved' },
        title: 'reviewed_approve',
      },
      { trigger: { trigger: 'status_change', to: 'approved' }, title: 'any_approve' },
      { trigger: { trigger: 'status_change' }, title: 'every_transition' },
    ])
    // draft → approved: the from-scoped trigger must NOT fire; the others do.
    assert.deepEqual(
      titles(graph, { kind: 'status_change', from: 'draft', to: 'approved' }, emptyCtx).sort(),
      ['any_approve', 'every_transition'],
    )
    // pending_approval → approved: all three fire.
    assert.deepEqual(
      titles(
        graph,
        { kind: 'status_change', from: 'pending_approval', to: 'approved' },
        emptyCtx,
      ).sort(),
      ['any_approve', 'every_transition', 'reviewed_approve'],
    )
    // → rejected: only the unfiltered trigger fires.
    assert.deepEqual(titles(graph, { kind: 'status_change', to: 'rejected' }, emptyCtx), [
      'every_transition',
    ])
  })

  test('on_update plans like a plain lifecycle trigger and carries edit data on the event', () => {
    const graph = graphOf([
      { trigger: { trigger: 'on_update' }, title: 'edited' },
      { trigger: { trigger: 'on_submit' }, title: 'submitted' },
    ])
    // Only the on_update trigger fires for the event; the extra event fields
    // (previousTotal/totalChanged, surfaced as eval values by the engine) do
    // not affect trigger matching.
    assert.deepEqual(
      titles(graph, { kind: 'on_update', previousTotal: '100.00', totalChanged: true }, emptyCtx),
      ['edited'],
    )
    // Conditions downstream can gate on the injected values.
    const conditional: AutomationGraph = {
      schemaVersion: 1,
      nodes: [
        {
          id: 't',
          position: { x: 0, y: 0 },
          data: { kind: 'trigger', trigger: { trigger: 'on_update' } },
        },
        {
          id: 'c',
          position: { x: 100, y: 0 },
          data: { kind: 'condition', rule: { op: 'eq', field: 'totalChanged', value: true } },
        },
        { id: 'a', position: { x: 200, y: 0 }, data: { kind: 'action', action: notify('material') } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'c', sourceHandle: 'next' },
        { id: 'e2', source: 'c', target: 'a', sourceHandle: 'then' },
      ],
    }
    const fires = planAutomation(
      conditional,
      { kind: 'on_update' },
      { values: { totalChanged: true }, rows: {} },
    )
    assert.deepEqual(fires.actionNodes.map((a) => a.nodeId), ['a'])
    const skips = planAutomation(
      conditional,
      { kind: 'on_update' },
      { values: { totalChanged: false }, rows: {} },
    )
    assert.deepEqual(skips.actionNodes, [])
  })

  test('manual planning targets a single button by id', () => {
    const graph = graphOf([
      { trigger: { trigger: 'manual', buttonId: 'b1', label: 'One' }, title: 'one' },
      { trigger: { trigger: 'manual', buttonId: 'b2', label: 'Two' }, title: 'two' },
    ])
    assert.deepEqual(titles(graph, { kind: 'manual', buttonId: 'b2' }, emptyCtx), ['two'])
  })

  test('scheduled planning targets only trigger nodes that are due', () => {
    const graph = graphOf([
      { trigger: { trigger: 'scheduled', cron: '0 8 * * *' }, title: 'daily' },
      { trigger: { trigger: 'scheduled', cron: '0 8 * * 1' }, title: 'weekly' },
    ])
    assert.deepEqual(titles(graph, { kind: 'scheduled' }, emptyCtx, { triggerNodeIds: ['t1'] }), [
      'weekly',
    ])
  })

  test('conditions branch then/else and gates pause the walk', () => {
    const graph: AutomationGraph = {
      schemaVersion: 1,
      nodes: [
        {
          id: 't',
          position: { x: 0, y: 0 },
          data: { kind: 'trigger', trigger: { trigger: 'on_submit' } },
        },
        {
          id: 'c',
          position: { x: 100, y: 0 },
          data: { kind: 'condition', rule: { op: 'gt', field: 'total', value: 1000 } },
        },
        {
          id: 'g',
          position: { x: 200, y: 0 },
          data: {
            kind: 'gate',
            gate: { title: 'Approval', assignees: [{ type: 'supervisor' }], mode: 'any' },
          },
        },
        { id: 'small', position: { x: 200, y: 100 }, data: { kind: 'action', action: notify('small') } },
        {
          id: 'after',
          position: { x: 300, y: 0 },
          data: { kind: 'action', action: { action: 'change_status', to: 'approved' } },
        },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'c', sourceHandle: 'next' },
        { id: 'e2', source: 'c', target: 'g', sourceHandle: 'then' },
        { id: 'e3', source: 'c', target: 'small', sourceHandle: 'else' },
        { id: 'e4', source: 'g', target: 'after', sourceHandle: 'approve' },
      ],
    }

    // Over threshold: reach the gate, pause — the approve branch is NOT planned.
    const big = planAutomation(graph, { kind: 'on_submit' }, { values: { total: 5000 }, rows: {} })
    assert.deepEqual(big.gates.map((g) => g.nodeId), ['g'])
    assert.deepEqual(big.actions, [])

    // Under threshold: the else branch runs, no gate.
    const small = planAutomation(graph, { kind: 'on_submit' }, { values: { total: 10 }, rows: {} })
    assert.deepEqual(small.gates, [])
    assert.deepEqual(small.actionNodes.map((a) => a.nodeId), ['small'])

    // Human decision resumes the approve branch.
    const resumed = planFromGate(graph, 'g', 'approve', emptyCtx)
    assert.deepEqual(resumed.actionNodes.map((a) => a.nodeId), ['after'])
    // The reject branch has no edges → empty plan.
    const rejected = planFromGate(graph, 'g', 'reject', emptyCtx)
    assert.deepEqual(rejected.actions, [])
    assert.deepEqual(rejected.gates, [])
  })

  test('cyclic graphs terminate (visited set)', () => {
    const graph: AutomationGraph = {
      schemaVersion: 1,
      nodes: [
        {
          id: 't',
          position: { x: 0, y: 0 },
          data: { kind: 'trigger', trigger: { trigger: 'on_create' } },
        },
        { id: 'a', position: { x: 100, y: 0 }, data: { kind: 'action', action: notify('once') } },
        { id: 'b', position: { x: 200, y: 0 }, data: { kind: 'action', action: notify('twice') } },
      ],
      edges: [
        { id: 'e1', source: 't', target: 'a', sourceHandle: 'next' },
        { id: 'e2', source: 'a', target: 'b', sourceHandle: 'next' },
        { id: 'e3', source: 'b', target: 'a', sourceHandle: 'next' }, // cycle
      ],
    }
    assert.deepEqual(titles(graph, { kind: 'on_create' }, emptyCtx), ['once', 'twice'])
  })
})

// --- Worker-trigger compatibility lint ------------------------------------------

describe('lintWorkerTriggerCompatibility', () => {
  test('allows worker-safe notifications and emails', () => {
    assert.deepEqual(
      lintWorkerTriggerCompatibility(
        schedGraphWith({ kind: 'action', action: notify('Reminder') }),
      ),
      [],
    )
    assert.deepEqual(
      lintWorkerTriggerCompatibility(
        schedGraphWith({
          kind: 'action',
          action: {
            action: 'send_email',
            to: [{ type: 'role', role: 'controller' }],
            subject: 'Weekly digest',
            body: 'Totals: {{total}}',
          },
        }),
      ),
      [],
    )
  })

  test('rejects worker trigger branches that cannot execute in the worker', () => {
    for (const action of [
      { action: 'set_field', field: 'memo', value: { kind: 'literal', value: 'x' } },
      { action: 'change_status', to: 'approved' },
      { action: 'post_document' },
      { action: 'webhook', url: 'https://example.com', method: 'POST' },
    ] as const satisfies readonly ActionData[]) {
      assert.ok(
        lintWorkerTriggerCompatibility(schedGraphWith({ kind: 'action', action })).includes(
          `Trigger trigger: "scheduled" runs in the worker and cannot execute "${action.action}".`,
        ),
        `expected ${action.action} to be rejected`,
      )
    }
  })

  test('scheduled + record select widens the safe set to set_field only', () => {
    const withSelect = (data: AutomationGraph['nodes'][number]['data']): AutomationGraph => ({
      schemaVersion: 1,
      nodes: [
        {
          id: 'trigger',
          position: { x: 0, y: 0 },
          data: {
            kind: 'trigger',
            trigger: {
              trigger: 'scheduled',
              cron: '*/30 * * * *',
              select: { rule: { op: 'eq', field: 'status', value: 'approved' }, limit: 100 },
            },
          },
        },
        { id: 'node', position: { x: 100, y: 0 }, data },
      ],
      edges: [{ id: 'edge', source: 'trigger', target: 'node', sourceHandle: 'next' }],
    })
    // set_field is legal WITH a record select (the EFT sent-latch pattern)…
    assert.deepEqual(
      lintWorkerTriggerCompatibility(
        withSelect({
          kind: 'action',
          action: { action: 'set_field', field: 'memo', value: { kind: 'literal', value: 'sent' } },
        }),
      ),
      [],
    )
    // …but status pipelines stay rejected even with a record in hand.
    assert.ok(
      lintWorkerTriggerCompatibility(
        withSelect({ kind: 'action', action: { action: 'change_status', to: 'approved' } }),
      ).length > 0,
    )
  })

  test('lock_record parses and is rejected from scheduled branches', () => {
    const graph = schedGraphWith({
      kind: 'action',
      action: { action: 'lock_record', reason: 'approved — locked', exemptRoles: ['controller'] },
    })
    assert.ok(automationGraphSchema.safeParse(graph).success)
    assert.ok(
      lintWorkerTriggerCompatibility(graph).includes(
        'Trigger trigger: "scheduled" runs in the worker and cannot execute "lock_record".',
      ),
    )
  })

  test('send_email attachPdf parses', () => {
    const parsed = automationGraphSchema.safeParse(
      schedGraphWith({
        kind: 'action',
        action: {
          action: 'send_email',
          to: [{ type: 'email', email: 'ap@example.com' }],
          subject: 'Remittance {{documentNumber}}',
          body: 'Attached.',
          attachPdf: true,
        },
      }),
    )
    assert.ok(parsed.success)
  })

  test('rejects gates reachable from a scheduled trigger', () => {
    assert.ok(
      lintWorkerTriggerCompatibility(
        schedGraphWith({
          kind: 'gate',
          gate: { title: 'Approval', assignees: [{ type: 'submitter' }], mode: 'any' },
        }),
      ).includes(
        'Trigger trigger: "scheduled" runs in the worker and cannot pause for approval gates.',
      ),
    )
  })
})

// --- Structural / profile lint ----------------------------------------------------

const invoiceProfile: FlowSubjectProfile = {
  subjectKind: 'invoice',
  label: 'Invoice',
  triggers: ['on_create', 'on_submit', 'after_post', 'status_change', 'on_field_value', 'manual'],
  actions: ['send_email', 'notify', 'set_field', 'change_status', 'post_document'],
  statuses: [
    { value: 'draft', label: 'Draft' },
    { value: 'pending_approval', label: 'Pending approval' },
    { value: 'approved', label: 'Approved' },
  ],
  fields: [
    { key: 'total', label: 'Total', type: 'number' },
    { key: 'memo', label: 'Memo', type: 'text', writable: true },
  ],
}
const invoiceFieldIds = new Set(invoiceProfile.fields.map((f) => f.key))

describe('lintAutomationGraph', () => {
  test('flags missing trigger, dangling edges, and unreachable nodes', () => {
    const errors = lintAutomationGraph(
      {
        schemaVersion: 1,
        nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { kind: 'action', action: notify('x') } }],
        edges: [{ id: 'e', source: 'ghost', target: 'a' }],
      },
      invoiceFieldIds,
    )
    assert.ok(errors.includes('Edge e: unknown source node'))
    assert.ok(errors.includes('Flow has no trigger — add a trigger node to start it.'))

    const unreachable = lintAutomationGraph(
      {
        schemaVersion: 1,
        nodes: [
          {
            id: 't',
            position: { x: 0, y: 0 },
            data: { kind: 'trigger', trigger: { trigger: 'on_submit' } },
          },
          { id: 'orphan', position: { x: 0, y: 100 }, data: { kind: 'action', action: notify('x') } },
        ],
        edges: [],
      },
      invoiceFieldIds,
    )
    assert.ok(unreachable.includes('Node orphan: unreachable — not connected to any trigger.'))
  })

  test('validates the graph against a subject profile', () => {
    const errors = lintAutomationGraph(
      {
        schemaVersion: 1,
        nodes: [
          {
            id: 't',
            position: { x: 0, y: 0 },
            // before_void is not in the invoice profile's trigger list.
            data: { kind: 'trigger', trigger: { trigger: 'before_void' } },
          },
          {
            id: 'a1',
            position: { x: 100, y: 0 },
            // 'voided' is not a known invoice status.
            data: { kind: 'action', action: { action: 'change_status', to: 'voided' } },
          },
          {
            id: 'a2',
            position: { x: 200, y: 0 },
            // total exists but is not writable.
            data: {
              kind: 'action',
              action: { action: 'set_field', field: 'total', value: { kind: 'literal', value: 0 } },
            },
          },
          {
            id: 'a3',
            position: { x: 300, y: 0 },
            // webhook is not in the invoice profile's action list.
            data: {
              kind: 'action',
              action: { action: 'webhook', url: 'https://example.com', method: 'POST' },
            },
          },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'a1' },
          { id: 'e2', source: 'a1', target: 'a2' },
          { id: 'e3', source: 'a2', target: 'a3' },
        ],
      },
      invoiceFieldIds,
      invoiceProfile,
    )
    assert.ok(errors.includes('Trigger t: "before_void" is not available for Invoice.'))
    assert.ok(errors.includes('Action a1: unknown destination status "voided".'))
    assert.ok(errors.includes('Action a2: field "total" is not writable by flows.'))
    assert.ok(errors.includes('Action a3: "webhook" is not available for Invoice.'))
  })

  test('flags unknown fields in conditions, on_field_value rules, and set_field', () => {
    const errors = lintAutomationGraph(
      {
        schemaVersion: 1,
        nodes: [
          {
            id: 't',
            position: { x: 0, y: 0 },
            data: {
              kind: 'trigger',
              trigger: { trigger: 'on_field_value', rule: { op: 'isSet', field: 'nope' } },
            },
          },
          {
            id: 'c',
            position: { x: 100, y: 0 },
            data: { kind: 'condition', rule: { op: 'eq', field: 'missing', value: 1 } },
          },
          {
            id: 'a',
            position: { x: 200, y: 0 },
            data: {
              kind: 'action',
              action: { action: 'set_field', field: 'ghost', value: { kind: 'literal', value: 1 } },
            },
          },
        ],
        edges: [
          { id: 'e1', source: 't', target: 'c' },
          { id: 'e2', source: 'c', target: 'a', sourceHandle: 'then' },
        ],
      },
      invoiceFieldIds,
    )
    assert.ok(errors.includes('Trigger t: references unknown field "nope"'))
    assert.ok(errors.includes('Condition c: references unknown field "missing"'))
    assert.ok(errors.includes('Action a: set_field targets unknown field "ghost"'))
  })
})
