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
// Subject profiles use the OpenBooks document vocabulary described in the
// flow execution contract.

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
  /** Closed vocabulary for enum-like condition values. The builder renders
   * these as choices instead of accepting typo-prone free text. */
  options?: FlowFieldOption[]
}

export type FlowFieldOption = {
  value: string
  label: string
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

const FLOW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const FLOW_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

function describeReceived(value: unknown): string {
  if (typeof value === 'string') {
    const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value
    return JSON.stringify(shown)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Date) return 'a Date'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * Refuse a `set_field` value whose runtime shape cannot inhabit the field's
 * declared FlowFieldType. Returns the refusal message, or null when the value
 * may be written. Null/undefined clears the field and is always allowed.
 *
 * `resolveDefaultValue` output is untyped (authored literals, formula results,
 * {{interpolation}}), so without this a flow persists e.g. a string into a
 * date column — failing at the driver, or worse, coercing silently. No
 * coercion here: guessing what the author meant is how a wrong value gets
 * stored. The remedy names the expected shape; the fix is in the flow.
 */
export function flowFieldValueError(def: FlowFieldDef, value: unknown): string | null {
  if (value === null || value === undefined) return null
  const refusal = (expected: string): string =>
    `set_field "${def.key}" expects ${expected} but received ${describeReceived(value)} — fix the value in the flow`
  switch (def.type) {
    case 'text':
      return typeof value === 'string' ? null : refusal('text')
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : refusal('a finite number')
    case 'bool':
      return typeof value === 'boolean' ? null : refusal('a boolean')
    case 'date': {
      if (value instanceof Date) return null
      if (typeof value === 'string' && (FLOW_DATE_RE.test(value) || FLOW_DATETIME_RE.test(value))) return null
      return refusal('a date (YYYY-MM-DD)')
    }
    case 'enum': {
      if (typeof value !== 'string') return refusal('text')
      if (def.options?.length && !def.options.some((o) => o.value === value)) {
        const names = def.options.map((o) => o.value)
        const shown = names.length > 12 ? `${names.slice(0, 12).join(', ')}, …` : names.join(', ')
        return `set_field "${def.key}" expects one of (${shown}) but received ${describeReceived(value)} — fix the value in the flow`
      }
      return null
    }
    case 'user':
      return typeof value === 'string' ? null : refusal('a user id')
  }
}
