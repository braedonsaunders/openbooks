import { validateSpec, type PageSpec } from '@braedonsaunders/appkit-viewspec'

/**
 * Whether a document is a spec this host can render.
 *
 * Deliberately NOT `server-only`. An API route validating a save, a test
 * asserting the rules, and an agent tool checking its own output all need this
 * same answer, and a validator that only exists inside the server bundle is a
 * validator that gets reimplemented — differently — everywhere else. The
 * database half lives in `./page-specs`, which is server-only because it
 * touches the tenant.
 */

export interface SpecRejection {
  ok: false
  errors: string[]
}

export type SpecAcceptance = { ok: true; spec: PageSpec }

/**
 * Validate a candidate spec against the closed schema AND the host's
 * registries.
 *
 * The schema alone is not enough. It constrains a widget name to a slug, not
 * to a name the host can actually render — so a spec naming `payrol-cockpit`
 * passes the schema and throws `UnknownWidgetError` mid-render, which is a
 * blank page for the tenant and a stack trace for us. The registries are
 * closed sets; checking membership here turns that into a save-time error
 * message naming the widget.
 *
 * Nor is a known NAME enough. Widget props are `Record<string, unknown>` by
 * design, so `placeholer` for `placeholder` is accepted, stored, and then
 * ignored at render — the author sees a page missing the thing they just set
 * and no message anywhere. `contracts` says which prop names each widget
 * actually reads, so an unreadable one is refused here with both names in the
 * message.
 *
 * Only UNKNOWN props are refused, never missing ones. A prop may be absent
 * because the widget has a default, and a spec that binds a field the loader
 * fills carries no type this could check anyway — the value does not exist
 * until render. Refusing what provably reaches nothing is the whole of the
 * honest claim.
 */
export function validateAgainstRegistries(
  candidate: unknown,
  registries: {
    widgets: ReadonlySet<string>
    frames: ReadonlySet<string>
    /** Prop names per widget. Omitted entirely, no props are checked. */
    contracts?: Readonly<Record<string, { props: readonly string[]; open?: true }>>
  },
): SpecAcceptance | SpecRejection {
  const result = validateSpec(candidate)
  if (!result.ok) return { ok: false, errors: result.errors }

  const errors: string[] = []
  const seen = { widgets: new Set<string>(), frames: new Set<string>() }
  const reported = new Set<string>()
  walk(result.spec, (name, kind, props) => {
    const known = kind === 'widget' ? registries.widgets : registries.frames
    const already = kind === 'widget' ? seen.widgets : seen.frames
    if (!known.has(name) && !already.has(name)) {
      already.add(name)
      errors.push(`unknown ${kind} "${name}"`)
      return
    }
    if (kind !== 'widget' || !props) return
    const contract = registries.contracts?.[name]
    // No contract, or a widget that forwards its props wholesale: nothing can
    // be said about its prop names, so nothing is.
    if (!contract || contract.open) return
    for (const prop of Object.keys(props)) {
      const key = `${name}.${prop}`
      if (contract.props.includes(prop) || reported.has(key)) continue
      reported.add(key)
      const near = closest(prop, contract.props)
      errors.push(
        `widget "${name}" does not read a prop called "${prop}"` +
          (near ? ` — did you mean "${near}"?` : ''),
      )
    }
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, spec: result.spec }
}

/**
 * The closest known prop name, when one is close enough to be worth guessing.
 *
 * A typo is the likeliest reason to be here, and "does not read a prop called
 * x" without a candidate leaves the author scanning a list of forty names.
 * Silent above a third of the word's length, because a wrong suggestion costs
 * more than none.
 */
function closest(prop: string, known: readonly string[]): string | null {
  let best: string | null = null
  let bestDistance = Math.floor(prop.length / 3) + 1
  for (const candidate of known) {
    const distance = editDistance(prop.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[b.length]!
}

/** Visit every widget and frame a spec mentions, at any depth, with its props. */
function walk(
  node: unknown,
  visit: (
    name: string,
    kind: 'widget' | 'frame',
    props?: Record<string, unknown>,
  ) => void,
): void {
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  // `widget` names one on a widget block, a widget cell and a widget ref
  // alike; `frame` only ever names a frame. Both are plain strings by schema.
  const props =
    record.props && typeof record.props === 'object' && !Array.isArray(record.props)
      ? (record.props as Record<string, unknown>)
      : undefined
  if (typeof record.widget === 'string') visit(record.widget, 'widget', props)
  if (typeof record.frame === 'string') visit(record.frame, 'frame')
  for (const value of Object.values(record)) walk(value, visit)
}
