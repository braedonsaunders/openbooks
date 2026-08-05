export type AuditDiffRow = { path: string; before: unknown; after: unknown }

type JsonObject = Record<string, unknown>

const CONTEXT_KEYS = new Set(['source', 'mode', 'reason'])
const TECHNICAL_OBJECT_KEYS = new Set([
  'id',
  'org_id',
  'document_id',
  'entry_id',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
])

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function arrayItemKey(value: unknown, index: number): string {
  if (!isObject(value)) return String(index + 1)
  const line = value.line_number
  if (typeof line === 'string' || typeof line === 'number') return `Line ${line}`
  const identifyingValue = value.name ?? value.document_number ?? value.entry_number
  return typeof identifyingValue === 'string' && identifyingValue.length > 0
    ? identifyingValue
    : String(index + 1)
}

function collectDiffs(before: unknown, after: unknown, path = ''): AuditDiffRow[] {
  if (sameValue(before, after)) return []
  if (Array.isArray(before) || Array.isArray(after)) {
    const left = Array.isArray(before) ? before : []
    const right = Array.isArray(after) ? after : []
    if (![...left, ...right].every((item) => isObject(item))) return [{ path, before, after }]

    const leftByKey = new Map(left.map((item, index) => [arrayItemKey(item, index), item]))
    const rightByKey = new Map(right.map((item, index) => [arrayItemKey(item, index), item]))
    const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])]
    return keys.flatMap((key) => collectDiffs(
      leftByKey.get(key),
      rightByKey.get(key),
      path ? `${path}.${key}` : key,
    ))
  }
  if (isObject(before) || isObject(after)) {
    const left = isObject(before) ? before : {}
    const right = isObject(after) ? after : {}
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter((key) => !TECHNICAL_OBJECT_KEYS.has(key))
      .sort()
    return keys.flatMap((key) => collectDiffs(left[key], right[key], path ? `${path}.${key}` : key))
  }
  return [{ path, before, after }]
}

export function auditEventDiffs(changesValue: unknown): AuditDiffRow[] {
  const changes = isObject(changesValue) ? changesValue : {}
  const hasBefore = Object.hasOwn(changes, 'before')
  const hasAfter = Object.hasOwn(changes, 'after')
  if (hasBefore || hasAfter) return collectDiffs(changes.before, changes.after)
  return Object.entries(changes)
    .filter(([key]) => !CONTEXT_KEYS.has(key))
    .flatMap(([key, value]) => Array.isArray(value) && value.length === 2
      ? [{ path: key, before: value[0], after: value[1] }]
      : [])
}
