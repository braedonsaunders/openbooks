// Flows — the pure automation-graph core for openbooks approvals & workflow.
//
// One graph per flow (stored in the `flows` table, one flow per subject kind).
// It is the single canvas that models BOTH:
//   • system automations (fire-and-forget Actions: email, notify, …)
//   • human sign-off (Gate nodes that PAUSE the flow until the assignee quorum
//     approves/rejects — persisted as `flow_gates` rows by the engine).
//
// Authored in the browser with React Flow (@xyflow/react) and serialized via
// `toObject()`; executed SERVER-SIDE only (RLS-bound, checkpointed in
// `flow_run_effects`) by `engine/src/flows/`. This module is deliberately
// framework-free — no DB, no Next.js, no node-only APIs — so the builder UI
// can import the planner from client components for live previews.
//
// Conditions + on_field_value triggers reuse the same `LogicRule` AST as the
// form builder's show-if / hard-fail rules, so there is one condition language
// and one LogicBuilder UI everywhere. `set_field` reuses
// `DefaultValueExpression` (resolved by `resolveDefaultValue`).
//
// Ported from beaconhs-platform's forms-core automation module; the trigger /
// action vocabulary is adapted to the openbooks ERP document lifecycle (see
// the flow execution contract).

import { z } from 'zod'
import {
  defaultValueExpressionSchema,
  logicRuleSchema,
  type DefaultValueExpression,
  type LogicRule,
} from './schema'
import { evaluateLogicRule, type EvalContext } from './evaluator'
import type { FlowSubjectProfile } from './flow-subjects'

// --- Targets (who / where) --------------------------------------------------

// Someone who can OWN an approval gate (must resolve to user ids at runtime).
//   user       — a specific user id.
//   role       — everyone holding an app role.
//   submitter  — the user who created/submitted the record.
//   supervisor — the submitter's manager (users.partyId → employee supervisor).
//   field      — a record field holding a user id (e.g. `salesRep`).
export const assigneeTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.string().min(1) }),
  z.object({ type: z.literal('role'), role: z.string().min(1) }),
  z.object({ type: z.literal('submitter') }),
  z.object({ type: z.literal('supervisor') }),
  z.object({ type: z.literal('field'), field: z.string().min(1).max(128) }),
])
export type AssigneeTarget = z.infer<typeof assigneeTargetSchema>

// Someone who can RECEIVE a message: any assignee target, plus a literal
// email address (which may hold a comma/semicolon-separated list).
export const recipientTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), userId: z.string().min(1) }),
  z.object({ type: z.literal('role'), role: z.string().min(1) }),
  z.object({ type: z.literal('submitter') }),
  z.object({ type: z.literal('supervisor') }),
  z.object({ type: z.literal('field'), field: z.string().min(1).max(128) }),
  z.object({ type: z.literal('email'), email: z.string().min(3).max(1_000) }),
])
export type RecipientTarget = z.infer<typeof recipientTargetSchema>

// --- Triggers (entry points) ------------------------------------------------

export const triggerDataSchema = z.discriminatedUnion('trigger', [
  // Document lifecycle moments, dispatched by the engine at the same hook
  // sites as trigger scripts (create / submit-for-approval / posting / void).
  z.object({ trigger: z.literal('on_create') }),
  // Fires after a record edit is saved (header/lines). The dispatching event
  // may expose `previousTotal` / `totalChanged` in the eval context so
  // conditions can implement "needs re-approval on material edit".
  z.object({ trigger: z.literal('on_update') }),
  z.object({ trigger: z.literal('on_submit') }),
  z.object({ trigger: z.literal('before_post') }),
  z.object({ trigger: z.literal('after_post') }),
  z.object({ trigger: z.literal('before_void') }),
  // Fires on a status transition. `from`/`to` narrow which transitions match;
  // both absent ⇒ every transition on the subject fires this trigger.
  z.object({
    trigger: z.literal('status_change'),
    from: z.string().max(64).optional(),
    to: z.string().max(64).optional(),
  }),
  // Fires alongside a lifecycle event when the record matches the rule
  // (evaluated against the record's EvalContext at dispatch time).
  z.object({ trigger: z.literal('on_field_value'), rule: logicRuleSchema }),
  // Runs off the 60s scheduler tick in the worker — see
  // `lintWorkerTriggerCompatibility` for what its branch may contain.
  //
  // `select` turns the schedule into a RECORD FAN-OUT (source platform "scheduled
  // workflow over a saved search"): each due occurrence loads candidate
  // records of the flow's subject kind, evaluates `select.rule` against each,
  // and starts ONE RUN PER MATCHING RECORD (capped by `select.limit`). With a
  // record in hand the branch may also `set_field` (e.g. a sent-latch
  // checkbox); without `select` there is no record, so only send_email/notify.
  z.object({
    trigger: z.literal('scheduled'),
    cron: z.string().min(1).max(128),
    tz: z.string().max(64).optional(),
    select: z
      .object({
        rule: logicRuleSchema.optional(),
        limit: z.number().int().positive().max(1_000).optional(),
      })
      .optional(),
  }),
  // A user-clickable button rendered on the record that runs THIS flow on
  // demand. Multiple manual triggers can coexist on one graph — each is a
  // distinct button keyed by `buttonId`, and planning with
  // `{ kind: 'manual', buttonId }` plans just that button's branch.
  // `showIf` / `requirePermission` gate the button's visibility/use.
  z.object({
    trigger: z.literal('manual'),
    buttonId: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
    confirm: z.string().max(500).optional(),
    requirePermission: z.string().max(128).optional(),
    showIf: logicRuleSchema.optional(),
  }),
])
export type TriggerData = z.infer<typeof triggerDataSchema>
export type TriggerKind = TriggerData['trigger']

// --- Actions (system side-effects; sinks or chain) --------------------------

export const actionDataSchema = z.discriminatedUnion('action', [
  // `subject` and `body` support {{field}} interpolation — see
  // `interpolateTemplate`. Delivery goes through the tenant's email settings.
  // `attachPdf` renders the subject record's PDF (the org's record template)
  // and attaches it — source platform's "include transaction" email option. When no
  // PDF renderer is registered in the executing process the email still sends,
  // with a recorded warning.
  z.object({
    action: z.literal('send_email'),
    to: z.array(recipientTargetSchema).min(1).max(20),
    subject: z.string().min(1).max(500),
    body: z.string().max(100_000),
    attachPdf: z.boolean().optional(),
  }),
  // In-app inbox notification (the `notifications` table). `href` deep-links
  // the notification to a record page.
  z.object({
    action: z.literal('notify'),
    to: z.array(recipientTargetSchema).min(1).max(20),
    title: z.string().min(1).max(200),
    body: z.string().max(2_000).optional(),
    href: z.string().max(2_000).optional(),
  }),
  // Persist a new value into a writable header field on the record.
  z.object({
    action: z.literal('set_field'),
    field: z.string().min(1).max(128),
    value: defaultValueExpressionSchema, // reuse the default-value evaluator
  }),
  // Adapter-mediated document lifecycle transition (draft → approved, …).
  z.object({ action: z.literal('change_status'), to: z.string().min(1).max(64) }),
  // Post the document to the GL (runs the normal posting pipeline).
  z.object({ action: z.literal('post_document') }),
  // Hard-lock the record against edits/void/delete until `unlock_record` runs
  // (source platform "Lock Record" with role exemptions — e.g. an approved payment
  // stays permanently locked except for admins + controllers). Admins are
  // always exempt; `exemptRoles` widens the exemption. Locks persist across
  // status changes (source platform donotexitworkflow terminal locks).
  z.object({
    action: z.literal('lock_record'),
    reason: z.string().max(500).optional(),
    exemptRoles: z.array(z.string().min(1).max(64)).max(10).optional(),
  }),
  z.object({ action: z.literal('unlock_record') }),
])
export type ActionData = z.infer<typeof actionDataSchema>
export type ActionKind = ActionData['action']

// --- Gate (human approve / reject — PAUSES the flow) ------------------------

// Multi-assignee quorum: `any` — the first decision wins; `all` — every
// resolved assignee must approve (one reject rejects). `reminderAfterHours` /
// `escalateAfterHours` are handled by the scheduler scan on `flow_gates`;
// escalation re-targets the gate at `escalateTo`.
export const gateDataSchema = z.object({
  title: z.string().min(1).max(200),
  assignees: z.array(assigneeTargetSchema).min(1).max(20),
  mode: z.enum(['any', 'all']),
  signatureRequired: z.boolean().optional(),
  // When true the engine drops the run's submitter from the resolved
  // assignees (source platform "prevent self-approval"); if that empties the list it
  // falls back to the submitter's supervisor, and failing that the run fails
  // loudly rather than letting the submitter sign off their own record.
  preventSelfApproval: z.boolean().optional(),
  reminderAfterHours: z.number().positive().max(24 * 365).optional(),
  escalateAfterHours: z.number().positive().max(24 * 365).optional(),
  escalateTo: assigneeTargetSchema.optional(),
})
export type GateData = z.infer<typeof gateDataSchema>

// --- Nodes (discriminated by data.kind) -------------------------------------

export const automationNodeSchema = z.object({
  id: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('trigger'), trigger: triggerDataSchema }),
    z.object({
      kind: z.literal('condition'),
      rule: logicRuleSchema,
      label: z.string().max(200).optional(),
    }),
    z.object({
      kind: z.literal('action'),
      action: actionDataSchema,
      label: z.string().max(200).optional(),
    }),
    z.object({ kind: z.literal('gate'), gate: gateDataSchema }),
  ]),
})
export type AutomationNode = z.infer<typeof automationNodeSchema>

// Edge branch selector lives on the source handle:
//   condition → 'then' | 'else'
//   gate      → 'approve' | 'reject'
//   otherwise → 'next' (default)
export const automationEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.enum(['next', 'then', 'else', 'approve', 'reject']).optional(),
})
export type AutomationEdge = z.infer<typeof automationEdgeSchema>

export const MAX_FLOW_NODES = 200
export const MAX_FLOW_EDGES = 400

export const automationGraphSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(automationNodeSchema).max(MAX_FLOW_NODES),
  edges: z.array(automationEdgeSchema).max(MAX_FLOW_EDGES),
})
export type AutomationGraph = z.infer<typeof automationGraphSchema>

export function emptyAutomationGraph(): AutomationGraph {
  return { schemaVersion: 1, nodes: [], edges: [] }
}

// --- {{field}} interpolation -------------------------------------------------

/**
 * Substitute `{{field}}` tokens in email/notification templates with the
 * record's header values from the EvalContext. Unknown/empty fields render as
 * '' (never "undefined"). Pure string work — HTML escaping is the DELIVERY
 * side's job (the engine escapes per transport).
 */
export function interpolateTemplate(template: string, ctx: EvalContext): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, rawKey: string) => {
    const v = ctx.values[rawKey.trim()]
    return v === null || v === undefined ? '' : String(v)
  })
}

// --- Engine: plan which actions/gates fire for a trigger ---------------------

/**
 * The concrete runtime event the engine dispatches into the planner. Carries
 * the trigger kind plus the event data needed to match trigger-node config
 * (status transition endpoints, which manual button was clicked, which
 * scheduled nodes are due via `opts.triggerNodeIds`).
 */
export type FlowEventSource = 'ui' | 'api' | 'sync' | 'script' | 'schedule' | 'close_automation'

export type TriggerEvent = (
  | { kind: 'on_create' }
  // The edit shape that fired the event; the engine surfaces these as
  // eval-context values so condition nodes can gate on material changes
  // (source platform's old-vs-new "needs re-approval" pattern):
  //   values.previousTotal / values.totalChanged — the document total delta
  //   values.changedFields     — header fields that materially changed
  //   values.changedLineFields — line-level fields that changed on ANY line
  //                              (adds/removes count as every field changing)
  //   values.old_total / values.old_taxTotal — pre-edit compare values
  // LogicRule `in` over an array value is ANY-OVERLAP, so
  //   { op:'in', field:'changedFields', value:['total','taxTotal'] }
  // reads "total or tax total changed".
  | {
      kind: 'on_update'
      previousTotal?: string | number | null
      totalChanged?: boolean
      changedFields?: string[]
      changedLineFields?: string[]
      old?: Record<string, unknown>
    }
  | { kind: 'on_submit' }
  | { kind: 'before_post' }
  | { kind: 'after_post' }
  | { kind: 'before_void' }
  | { kind: 'status_change'; from?: string | null; to: string }
  | { kind: 'on_field_value' }
  | { kind: 'scheduled' }
  | { kind: 'manual'; buttonId?: string }
) & {
  // Where the mutation came from — surfaced as `values.event_source` so
  // conditions can e.g. auto-approve system-generated records (source platform's
  // execution-context filters). Engine default when absent: 'api'.
  source?: FlowEventSource
}

// A reached gate carries its node id so the runtime can persist a `flow_gates`
// row keyed back to the exact node and RESUME the correct branch on a human
// decision. Actions likewise carry node ids for `flow_run_effects` checkpoints.
export type PlannedGate = { nodeId: string; gate: GateData }
export type PlannedAction = { nodeId: string; action: ActionData }
export type AutomationPlan = {
  actions: ActionData[]
  actionNodes: PlannedAction[]
  gates: PlannedGate[]
}

const EMPTY_PLAN: AutomationPlan = Object.freeze({ actions: [], actionNodes: [], gates: [] })

// Shared traversal: from each start node, collect ordered Actions and pause at
// Gates. Conditions branch then/else; gates pause (their approve/reject branch
// is resumed later via `planFromGate`). Cycle-safe via a shared `seen` set,
// which also dedupes nodes that multiple satisfied triggers converge on.
// Ordering is deterministic: start ids in graph order, then edge order.
function collect(graph: AutomationGraph, evalCtx: EvalContext, startIds: string[]): AutomationPlan {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const out = (id: string) => graph.edges.filter((e) => e.source === id)
  const actions: ActionData[] = []
  const actionNodes: PlannedAction[] = []
  const gates: PlannedGate[] = []
  const seen = new Set<string>()

  const walk = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    const node = byId.get(id)
    if (!node) return
    const d = node.data
    if (d.kind === 'action') {
      actions.push(d.action)
      actionNodes.push({ nodeId: id, action: d.action })
      for (const e of out(id)) walk(e.target)
      return
    }
    if (d.kind === 'gate') {
      gates.push({ nodeId: id, gate: d.gate })
      return // pause — approve/reject branch resumes on human decision
    }
    if (d.kind === 'condition') {
      const pass = evaluateLogicRule(d.rule, evalCtx)
      for (const e of out(id)) {
        const h = e.sourceHandle ?? 'then'
        if ((pass && (h === 'then' || h === 'next')) || (!pass && h === 'else')) walk(e.target)
      }
      return
    }
    // trigger node → follow onward
    for (const e of out(id)) walk(e.target)
  }
  for (const id of startIds) walk(id)
  return { actions, actionNodes, gates }
}

/**
 * Plan the Actions + Gates reached from EVERY trigger node matching `event`.
 * Pure: the caller performs the side effects server-side.
 *
 * A graph may legitimately carry several triggers of the same kind (multiple
 * manual buttons, several `on_field_value` branches with different rules, or
 * distinct `status_change` transitions). Each satisfied trigger contributes
 * its downstream branch; the branches are collected together so a shared
 * `seen` set dedupes any actions two triggers converge on. Planning only the
 * first matching node would silently drop the rest.
 *
 * Trigger-specific selection:
 *   • `manual` — when `event.buttonId` is supplied, plan just that button;
 *     otherwise plan every manual button (rare, but well-defined).
 *   • `on_field_value` — a node fires only when its own rule passes against
 *     `evalCtx`.
 *   • `status_change` — the node's `to` (and optional `from`) filter must
 *     match the event's transition, so a `from: X → to: Y` node does not fire
 *     on `Z → Y`. A node with neither filter fires on every transition.
 *   • `scheduled` — pass `opts.triggerNodeIds` with the node ids whose cron is
 *     due so an hourly and a weekly schedule on one graph fire independently.
 */
export function planAutomation(
  graph: AutomationGraph,
  event: TriggerEvent,
  evalCtx: EvalContext,
  opts?: {
    /** Restrict same-kind planning to these exact trigger node ids. */
    triggerNodeIds?: string[]
  },
): AutomationPlan {
  const startIds: string[] = []
  for (const node of graph.nodes) {
    if (node.data.kind !== 'trigger' || node.data.trigger.trigger !== event.kind) continue
    if (opts?.triggerNodeIds && !opts.triggerNodeIds.includes(node.id)) continue
    const td = node.data.trigger

    if (td.trigger === 'manual' && event.kind === 'manual' && event.buttonId !== undefined) {
      if (td.buttonId !== event.buttonId) continue
    }
    if (td.trigger === 'on_field_value' && !evaluateLogicRule(td.rule, evalCtx)) continue
    if (td.trigger === 'status_change' && event.kind === 'status_change') {
      if (td.to !== undefined && td.to !== event.to) continue
      if (td.from !== undefined && td.from !== (event.from ?? undefined)) continue
    }

    startIds.push(node.id)
  }
  if (startIds.length === 0) return { ...EMPTY_PLAN }
  return collect(graph, evalCtx, startIds)
}

/**
 * Resume a paused flow from a Gate's `approve` / `reject` branch after the
 * assignee quorum decides. Returns the downstream Actions + any further Gates.
 */
export function planFromGate(
  graph: AutomationGraph,
  gateNodeId: string,
  branch: 'approve' | 'reject',
  evalCtx: EvalContext,
): AutomationPlan {
  const targets = graph.edges
    .filter((e) => e.source === gateNodeId && (e.sourceHandle ?? 'approve') === branch)
    .map((e) => e.target)
  return collect(graph, evalCtx, targets)
}

// --- Static lint (best-effort; surfaced in the builder) ----------------------

/**
 * Structural + vocabulary lint for a flow graph. `fieldIds` are the header
 * field keys the subject exposes (usually `profile.fields` keys); when a
 * `FlowSubjectProfile` is supplied, triggers/actions/statuses outside the
 * subject's vocabulary and non-writable `set_field` targets are rejected too.
 * Returns human-readable error strings; empty ⇒ the graph is publishable.
 */
export function lintAutomationGraph(
  graph: AutomationGraph,
  fieldIds: Set<string>,
  profile?: FlowSubjectProfile,
): string[] {
  const errors: string[] = []
  const ids = new Set(graph.nodes.map((n) => n.id))

  if (graph.nodes.length > MAX_FLOW_NODES) {
    errors.push(`Flow has ${graph.nodes.length} nodes — the maximum is ${MAX_FLOW_NODES}.`)
  }
  if (graph.edges.length > MAX_FLOW_EDGES) {
    errors.push(`Flow has ${graph.edges.length} edges — the maximum is ${MAX_FLOW_EDGES}.`)
  }

  for (const e of graph.edges) {
    if (!ids.has(e.source)) errors.push(`Edge ${e.id}: unknown source node`)
    if (!ids.has(e.target)) errors.push(`Edge ${e.id}: unknown target node`)
  }

  const triggerIds = graph.nodes.filter((n) => n.data.kind === 'trigger').map((n) => n.id)
  if (triggerIds.length === 0) {
    errors.push('Flow has no trigger — add a trigger node to start it.')
  } else {
    // Unreachable nodes: not wired (directly or transitively) to any trigger.
    // Only meaningful once a trigger exists — otherwise EVERYTHING is
    // unreachable and the missing-trigger error already says so.
    const reachable = new Set<string>()
    const visit = (id: string) => {
      if (reachable.has(id)) return
      reachable.add(id)
      for (const e of graph.edges) if (e.source === id) visit(e.target)
    }
    for (const id of triggerIds) visit(id)
    for (const n of graph.nodes) {
      if (!reachable.has(n.id)) {
        errors.push(`Node ${n.id}: unreachable — not connected to any trigger.`)
      }
    }
  }

  // When a subject profile is supplied, reject triggers/actions the subject
  // does not support (e.g. a journal flow using `post_document` when journals
  // post immediately) and status values outside the subject's lifecycle.
  if (profile) {
    const okTriggers = new Set<string>(profile.triggers)
    const okActions = new Set<string>(profile.actions)
    const okStatuses = new Set(profile.statuses.map((s) => s.value))
    const writable = new Set(profile.fields.filter((f) => f.writable).map((f) => f.key))
    for (const n of graph.nodes) {
      if (n.data.kind === 'trigger') {
        const td = n.data.trigger
        if (!okTriggers.has(td.trigger)) {
          errors.push(`Trigger ${n.id}: "${td.trigger}" is not available for ${profile.label}.`)
        }
        if (td.trigger === 'status_change') {
          if (td.to !== undefined && !okStatuses.has(td.to)) {
            errors.push(`Trigger ${n.id}: unknown destination status "${td.to}".`)
          }
          if (td.from !== undefined && !okStatuses.has(td.from)) {
            errors.push(`Trigger ${n.id}: unknown source status "${td.from}".`)
          }
        }
      }
      if (n.data.kind === 'action') {
        const ad = n.data.action
        if (!okActions.has(ad.action)) {
          errors.push(`Action ${n.id}: "${ad.action}" is not available for ${profile.label}.`)
        }
        if (ad.action === 'change_status' && !okStatuses.has(ad.to)) {
          errors.push(`Action ${n.id}: unknown destination status "${ad.to}".`)
        }
        if (ad.action === 'set_field' && fieldIds.has(ad.field) && !writable.has(ad.field)) {
          errors.push(`Action ${n.id}: field "${ad.field}" is not writable by flows.`)
        }
      }
    }
  }

  const walkRuleFields = (rule: LogicRule, where: string) => {
    if ('rules' in rule) rule.rules.forEach((r) => walkRuleFields(r, where))
    else if ('rule' in rule) walkRuleFields(rule.rule, where)
    else if ('field' in rule && !fieldIds.has(rule.field)) {
      errors.push(`${where}: references unknown field "${rule.field}"`)
    }
  }
  for (const n of graph.nodes) {
    if (n.data.kind === 'condition') walkRuleFields(n.data.rule, `Condition ${n.id}`)
    if (n.data.kind === 'trigger' && n.data.trigger.trigger === 'on_field_value') {
      walkRuleFields(n.data.trigger.rule, `Trigger ${n.id}`)
    }
    if (n.data.kind === 'trigger' && n.data.trigger.trigger === 'manual' && n.data.trigger.showIf) {
      walkRuleFields(n.data.trigger.showIf, `Trigger ${n.id}`)
    }
    if (
      n.data.kind === 'action' &&
      n.data.action.action === 'set_field' &&
      !fieldIds.has(n.data.action.field)
    ) {
      errors.push(`Action ${n.id}: set_field targets unknown field "${n.data.action.field}"`)
    }
  }
  errors.push(...lintWorkerTriggerCompatibility(graph))
  return errors
}

const WORKER_ONLY_TRIGGERS = new Set<TriggerKind>(['scheduled'])
const WORKER_SAFE_ACTIONS = new Set<ActionKind>(['send_email', 'notify'])
// With a record fan-out (`select`) each scheduled run HAS a subject record, so
// persisting into it is well-defined (the EFT "sent" latch pattern). Status
// pipelines, gates, and posting stay excluded from the tick.
const WORKER_SAFE_ACTIONS_WITH_RECORD = new Set<ActionKind>(['send_email', 'notify', 'set_field'])

/** The action vocabulary a scheduled trigger's branch may use at runtime. */
export function scheduledSafeActions(hasRecordSelect: boolean): Set<ActionKind> {
  return hasRecordSelect ? WORKER_SAFE_ACTIONS_WITH_RECORD : WORKER_SAFE_ACTIONS
}

/**
 * Scheduled triggers execute off the worker's scheduler tick, not in a web
 * request with a live record mutation pipeline. The tick's executor is
 * narrow — email + in-app notify, plus set_field when the trigger declares a
 * record `select` (fan-out gives each run a real record). Reject branches
 * that would otherwise save successfully and then silently no-op — gates
 * (nothing to pause) and status pipelines (change_status / post_document).
 */
export function lintWorkerTriggerCompatibility(graph: AutomationGraph): string[] {
  const errors: string[] = []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const outbound = (id: string) => graph.edges.filter((e) => e.source === id)

  for (const trigger of graph.nodes) {
    if (
      trigger.data.kind !== 'trigger' ||
      !WORKER_ONLY_TRIGGERS.has(trigger.data.trigger.trigger)
    ) {
      continue
    }
    const triggerName = trigger.data.trigger.trigger
    const safeActions =
      trigger.data.trigger.trigger === 'scheduled'
        ? scheduledSafeActions(!!trigger.data.trigger.select)
        : WORKER_SAFE_ACTIONS
    const seen = new Set<string>()
    const walk = (nodeId: string) => {
      if (seen.has(nodeId)) return
      seen.add(nodeId)
      const node = byId.get(nodeId)
      if (!node) return
      if (node.id !== trigger.id && node.data.kind === 'trigger') return

      if (node.data.kind === 'gate') {
        errors.push(
          `Trigger ${trigger.id}: "${triggerName}" runs in the worker and cannot pause for approval gates.`,
        )
        return
      }

      if (node.data.kind === 'action' && !safeActions.has(node.data.action.action)) {
        errors.push(
          `Trigger ${trigger.id}: "${triggerName}" runs in the worker and cannot execute "${node.data.action.action}".`,
        )
      }

      for (const edge of outbound(nodeId)) walk(edge.target)
    }

    for (const edge of outbound(trigger.id)) walk(edge.target)
  }

  return Array.from(new Set(errors))
}

// Re-export the reused condition/value types so flow consumers import from one
// module.
export type { DefaultValueExpression, LogicRule }
