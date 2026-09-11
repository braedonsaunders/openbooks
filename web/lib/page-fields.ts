/**
 * Describe what a page's loader output offers a layout to bind.
 *
 * A ViewSpec field reference is a dot path and nothing else — `{ "$": "a.b" }`
 * — so "what can I bind here" has an exact, mechanical answer: the dot paths
 * that exist on the data the loader produced. Without it an author writes
 * layouts blind, and a wrong path is invisible: resolution returns `undefined`
 * for a missing field by design, so the page renders with a hole rather than
 * an error. This turns that silent failure into something knowable up front.
 *
 * Arrays get their ITEM shape described separately rather than flattened,
 * because the language treats them differently: a `table` binds the array to
 * `rows` and then resolves its columns against each ROW. Reporting
 * `lines.0.amount` would describe a path no table can use.
 *
 * No `server-only`: this is a pure function over a plain object and its tests
 * run in node.
 */

/** How a value may be bound, phrased in the language's own terms. */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array'
  /** A rendered React element. Present in the data, but nothing can bind it. */
  | 'node'
  /** A function or other value a spec has no way to express. */
  | 'unbindable'

export interface FieldDescriptor {
  /** Dot path, relative to the scope this descriptor belongs to. */
  path: string
  type: FieldType
  /** For arrays: how many items the loader produced on this run. */
  count?: number
  /** For arrays: the paths available on each ITEM, relative to the item. */
  item?: FieldDescriptor[]
  /** A short rendering of the value, so an author can see what it holds. */
  sample?: string
  /** Set when this subtree was cut off by the depth or size budget. */
  truncated?: boolean
}

export interface FieldCatalog {
  fields: FieldDescriptor[]
  /** True when the budget stopped the walk before it finished. */
  truncated: boolean
}

const MAX_DEPTH = 4
const MAX_FIELDS = 600
const SAMPLE_CHARS = 120
/** Enough items to see that a row shape is consistent, few enough to stay cheap. */
const ARRAY_PROBE = 3

function classify(value: unknown): FieldType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string': return 'string'
    case 'number':
    case 'bigint': return 'number'
    case 'boolean': return 'boolean'
    case 'undefined': return 'null'
    case 'function': return 'unbindable'
    case 'symbol': return 'unbindable'
  }
  // A React element is an object, and reporting it as one would invite an
  // author to bind `header.props.children` — a path that resolves to something
  // no block can render. Saying so is the difference between a catalog and a
  // list of properties.
  if (isReactNode(value)) return 'node'
  if (value instanceof Date) return 'string'
  return 'object'
}

function isReactNode(value: object): boolean {
  return '$$typeof' in value && typeof (value as { $$typeof: unknown }).$$typeof === 'symbol'
}

function sampleOf(value: unknown, type: FieldType): string | undefined {
  if (type === 'object' || type === 'array' || type === 'node' || type === 'unbindable') return undefined
  if (value === null || value === undefined) return undefined
  if (value instanceof Date) return value.toISOString()
  const text = typeof value === 'string' ? value : String(value)
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text
}

/**
 * The paths a spec may bind against this scope.
 *
 * Values are sampled, not just typed. A layout author choosing between
 * `summary.total` and `summary.totalFormatted` needs to see that one is
 * `"12345.67"` and the other `"$12,345.67"`; the type alone says `string` for
 * both. The samples are the caller's OWN data — the loader ran under their
 * permissions and this describes what it returned — so nothing here is visible
 * that reading the page would not already show.
 */
export function describeFields(scope: unknown): FieldCatalog {
  const budget = { remaining: MAX_FIELDS }
  const fields = walk(scope, '', 0, budget)
  return { fields, truncated: budget.remaining <= 0 }
}

function walk(
  scope: unknown,
  prefix: string,
  depth: number,
  budget: { remaining: number },
): FieldDescriptor[] {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return []
  const out: FieldDescriptor[] = []
  for (const key of Object.keys(scope).sort()) {
    if (budget.remaining <= 0) break
    budget.remaining--
    // A key that is not a plain identifier cannot be written in a dot path, so
    // it is not bindable and listing it would be a lie.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) continue
    const value = (scope as Record<string, unknown>)[key]
    const type = classify(value)
    const path = prefix ? `${prefix}.${key}` : key
    const descriptor: FieldDescriptor = { path, type }
    const sample = sampleOf(value, type)
    if (sample !== undefined) descriptor.sample = sample

    if (type === 'array') {
      const items = value as unknown[]
      descriptor.count = items.length
      if (depth + 1 > MAX_DEPTH) descriptor.truncated = true
      else descriptor.item = itemShape(items, depth + 1, budget)
    } else if (type === 'object') {
      if (depth + 1 > MAX_DEPTH) descriptor.truncated = true
      else {
        const children = walk(value, path, depth + 1, budget)
        // A nested object contributes its leaves; the container itself is
        // listed too, because `repeat` and `table` bind containers.
        out.push(descriptor, ...children)
        continue
      }
    }
    out.push(descriptor)
  }
  return out
}

/**
 * The shape of an array's items, merged across the first few.
 *
 * Merged rather than read off item 0, because rows are not always uniform —
 * an optional `drillTarget` present on some lines and absent on others is
 * exactly the field an author needs to know about, and item 0 might be the one
 * without it. The item paths are relative, which is how a table's columns
 * resolve them.
 *
 * `depth` is the array's own depth, carried through rather than reset. Reset
 * to zero, a self-referential structure — data that holds a node holding the
 * array again — would descend forever, bounded only by the field budget and
 * emitting nonsense paths on the way.
 */
function itemShape(
  items: unknown[],
  depth: number,
  budget: { remaining: number },
): FieldDescriptor[] {
  const merged = new Map<string, FieldDescriptor>()
  for (const item of items.slice(0, ARRAY_PROBE)) {
    if (budget.remaining <= 0) break
    for (const field of walk(item, '', depth, budget)) {
      const existing = merged.get(field.path)
      // A path seen as `null` in one row and `string` in another is a string
      // field that is sometimes empty. Keeping the informative type is more
      // useful than keeping whichever row came first.
      if (!existing || existing.type === 'null') merged.set(field.path, field)
    }
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Every dot path a spec actually binds, so an author can see which parts of
 * the data the built-in layout uses — and, by difference, which it ignores.
 */
export function boundPaths(spec: unknown): string[] {
  const paths = new Set<string>()
  const visit = (node: unknown) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.$ === 'string' && Object.keys(record).length === 1) {
      paths.add(record.$)
      return
    }
    for (const child of Object.values(record)) visit(child)
  }
  visit(spec)
  return [...paths].sort()
}
