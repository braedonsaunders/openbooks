// Flow SUBJECTS — the small abstraction that lets ONE Flows engine + ONE
// canvas drive every automatable record kind (invoices, bills, journals,
// purchase orders, …).
//
// A `FlowSubjectProfile` is pure data describing what a subject offers: which
// triggers/actions are valid, which lifecycle statuses exist, and the field
// "tokens" available for conditions, {{interpolation}}, and recipient/assignee
// `field` targets. The builder canvas renders against this profile;
// `lintAutomationGraph(graph, fieldIds, profile)` rejects anything outside it
// at author time. Server-side behaviour lives in the matching subject adapter
// (engine/src/flows/registry.ts).
//
// Ported from beaconhs-platform's flow-subjects module, adapted to the
// openbooks document vocabulary (see docs/flows-design.md).

import type { TriggerKind, ActionKind } from './automation'

/** Coarse value type of a subject field — drives the LogicBuilder editor. */
export type FlowFieldType = 'text' | 'number' | 'bool' | 'date' | 'enum' | 'user'

/** A lifecycle status a subject's records move through. */
export type FlowStatusDef = {
  value: string
  label: string
}

/**
 * A merge token / condition field exposed by a subject. `writable` marks
 * header fields a flow may persist into via `set_field` — everything else is
 * read-only from a flow's point of view.
 */
export type FlowFieldDef = {
  key: string
  label: string
  type: FlowFieldType
  writable?: boolean
}

export type FlowSubjectProfile = {
  /** Subject discriminator, e.g. a document kind: 'invoice', 'bill', 'journal'. */
  subjectKind: string
  /** Human label used in lint messages + canvas chrome. */
  label: string
  /** Trigger kinds the subject dispatches (its lifecycle hook sites). */
  triggers: TriggerKind[]
  /** Action kinds the subject's adapter can execute. */
  actions: ActionKind[]
  /** Lifecycle statuses — allowed values for status_change / change_status. */
  statuses: FlowStatusDef[]
  /** Field tokens for conditions, {{interpolation}}, and `field` targets. */
  fields: FlowFieldDef[]
  /** Role names offered by the assignee/recipient `role` target picker. */
  roles?: string[]
}

/** The field keys a profile exposes — the `fieldIds` for `lintAutomationGraph`. */
export function profileFieldIds(profile: FlowSubjectProfile): Set<string> {
  return new Set(profile.fields.map((f) => f.key))
}
