import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The home-dashboard registry cannot drift.
 *
 * A dashboard tile is four decisions in four files: a `WIDGETS` entry
 * (`_widget-registry.ts`), a `WidgetCard` render case (`_widget-views.tsx`),
 * a `WIDGET_PERMISSIONS` entry (`_widget-access.ts`), and a
 * `WIDGET_METRIC_FIELDS` entry (`_metrics.ts`). Before this test, nothing
 * tied them together: a tile added to `WIDGETS` without a permission entry
 * fell through to `id in WIDGETS → true` and shipped ungated, a tile
 * without a metric-fields entry silently received zeroed metrics (a KPI
 * rendering `0` that reads as a fact), and a tile without a render case
 * rendered the "unknown" shell. Each failure mode is silent at runtime.
 *
 * The rule, in both directions: the four sets agree exactly. The only
 * exceptions are named below with their justification, and shrinking those
 * lists is always safe.
 *
 * Like `registry-names.test.ts`, this reads SOURCE rather than importing:
 * importing would drag the dashboard's client graph into a plain node test.
 */

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

/** Top-level quoted keys of the object literal opened right after `anchor`. */
function literalKeys(source: string, anchor: string): string[] {
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, `declaration not found: ${anchor}`)
  const open = source.indexOf('{', start)
  const keys: string[] = []
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]!
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      const from = i
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++
        i++
      }
      if (depth === 1 && /^\s*:/.test(source.slice(i + 1))) keys.push(source.slice(from + 1, i))
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1
      continue
    }
    if (c === '{' || c === '(' || c === '[') { depth++; continue }
    if (c === '}' || c === ')' || c === ']') { depth--; if (depth === 0) break; continue }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      const word = /^[A-Za-z0-9_$]+/.exec(source.slice(i))![0]
      if (/^\s*:/.test(source.slice(i + word.length))) keys.push(word)
      i += word.length - 1
    }
  }
  return keys
}

const registry = read('./_widget-registry.ts')
const views = read('./_widget-views.tsx')
const access = read('./_widget-access.ts')
const metrics = read('./_metrics.ts')

const widgetIds = literalKeys(registry, 'export const WIDGETS')
const permissionIds = literalKeys(access, 'const WIDGET_PERMISSIONS')
const metricFieldIds = literalKeys(metrics, 'const WIDGET_METRIC_FIELDS')
const renderCases = [...views.matchAll(/^\s*case '([^']+)'/gm)].map((m) => m[1]!)

/**
 * Tiles the grid renders itself instead of through `WidgetCard`.
 * `personal-actions` is intercepted by `nodeFor` in `_dashboard-grid.tsx`
 * (both slots pass `quickActionsSaveAction`), because quick actions need a
 * bound server action and `WidgetCard` only receives metrics. If this list
 * ever holds more than one entry, that is a second render path growing —
 * prefer a metrics-driven card instead.
 */
const SLOT_RENDERED = ['personal-actions']

test('every widget has an explicit permission entry (no silent fallthrough)', () => {
  const missing = widgetIds.filter((id) => !permissionIds.includes(id))
  const orphan = permissionIds.filter((id) => !widgetIds.includes(id))
  assert.deepEqual(
    { missing, orphan },
    { missing: [], orphan: [] },
    'a WIDGETS id with no WIDGET_PERMISSIONS entry renders for everyone; ' +
      'a permission entry naming no widget guards nothing',
  )
})

test('every widget declares the metric fields it renders (no silent zeroes)', () => {
  const missing = widgetIds.filter((id) => !metricFieldIds.includes(id))
  const orphan = metricFieldIds.filter((id) => !widgetIds.includes(id))
  assert.deepEqual(
    { missing, orphan },
    { missing: [], orphan: [] },
    'a widget missing from WIDGET_METRIC_FIELDS receives zeroed metrics — ' +
      'a KPI rendering 0 that reads as a fact',
  )
})

test('every widget has a render case or a named slot path (no unknown shell)', () => {
  const unrendered = widgetIds.filter(
    (id) => !renderCases.includes(id) && !SLOT_RENDERED.includes(id),
  )
  const deadCases = renderCases.filter((id) => !widgetIds.includes(id))
  const straySlots = SLOT_RENDERED.filter((id) => !widgetIds.includes(id))
  assert.deepEqual(
    { unrendered, deadCases, straySlots },
    { unrendered: [], deadCases: [], straySlots: [] },
    'a widget with no WidgetCard case renders the unknown-widget shell; ' +
      'a case naming no widget is dead code',
  )
})

test('every widget names dashboard-catalog copy that exists in English', () => {
  const en = JSON.parse(read('../../../messages/en/dashboard.json')) as unknown
  const flat = new Map<string, string>()
  const walk = (node: unknown, path: string[]) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') flat.set([...path, key].join('.'), value)
      else walk(value, [...path, key])
    }
  }
  walk(en, [])
  const labelKeys = [...registry.matchAll(/labelKey: '([^']+)'/g)].map((m) => m[1]!)
  const descriptionKeys = [...registry.matchAll(/descriptionKey: '([^']+)'/g)].map((m) => m[1]!)
  // dashboard.quickActions.title is namespaced outside widgets.* — resolve
  // through the catalog the same way the component does.
  const missing = [...labelKeys, ...descriptionKeys].filter((key) => {
    const [ns, ...rest] = key.split('.')
    return !flat.has(ns === 'dashboard' ? rest.join('.') : key)
  })
  assert.deepEqual(missing, [], 'widget copy keys must exist in messages/en/dashboard.json')
})
