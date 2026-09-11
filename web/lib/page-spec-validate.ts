import { validateSpec, type PageSpec } from '@openbooks/viewspec'

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
 */
export function validateAgainstRegistries(
  candidate: unknown,
  registries: { widgets: ReadonlySet<string>; frames: ReadonlySet<string> },
): SpecAcceptance | SpecRejection {
  const result = validateSpec(candidate)
  if (!result.ok) return { ok: false, errors: result.errors }

  const errors: string[] = []
  const seen = { widgets: new Set<string>(), frames: new Set<string>() }
  walk(result.spec, (name, kind) => {
    const known = kind === 'widget' ? registries.widgets : registries.frames
    const already = kind === 'widget' ? seen.widgets : seen.frames
    if (known.has(name) || already.has(name)) return
    already.add(name)
    errors.push(`unknown ${kind} "${name}"`)
  })
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, spec: result.spec }
}

/** Visit every widget and frame name a spec mentions, at any depth. */
function walk(node: unknown, visit: (name: string, kind: 'widget' | 'frame') => void): void {
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  // `widget` names one on a widget block, a widget cell and a widget ref
  // alike; `frame` only ever names a frame. Both are plain strings by schema.
  if (typeof record.widget === 'string') visit(record.widget, 'widget')
  if (typeof record.frame === 'string') visit(record.frame, 'frame')
  for (const value of Object.values(record)) walk(value, visit)
}
