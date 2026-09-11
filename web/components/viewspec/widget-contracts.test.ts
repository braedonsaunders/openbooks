import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import type * as TS from 'typescript'
import { registryContracts } from '../../../scripts/widget-contracts-source.mjs'
import { WIDGET_CONTRACTS } from './widget-contracts'

/**
 * `widget-contracts.ts` decides which props a saved layout may name, so a
 * stale entry is not cosmetic: too few names refuses a prop that works, too
 * many lets a typo through silently. It is generated, and a generated file
 * nobody regenerates is a file that lies.
 *
 * Two different things are checked here and both matter.
 *
 * DRIFT — the file still says what the registry says, re-derived with the
 * generator's own parser. Reimplementing the parse here would test that two
 * parsers agree, not that the contracts match the widgets.
 *
 * REALITY — every widget prop the app's own 166 pages actually pass is one
 * the contract allows. This is the check that makes the feature safe to turn
 * on: the contracts are extracted mechanically, and the only way to know the
 * extraction is right is to hold it against every real usage. A miss here
 * would refuse a layout that renders correctly today, which is worse than the
 * silent typo the contracts exist to catch.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')
const WIDGETS = join(ROOT, 'web', 'components', 'viewspec', 'widgets.tsx')
const APP_DIR = join(ROOT, 'web', 'app', '(app)')

// Typed, not left as `any`: `ts.isCallExpression` is a type predicate, and an
// untyped require turns it into a plain boolean that narrows nothing.
const ts: typeof TS = createRequire(join(ROOT, 'web', 'package.json'))('typescript')

test('the contracts still say what the widget registry says', () => {
  const derived = registryContracts(readFileSync(WIDGETS, 'utf8'), 'WIDGET_REGISTRY') as Record<
    string,
    { props: string[]; open: boolean }
  >
  assert.ok(Object.keys(derived).length > 300, 'the registry parse found almost nothing')

  const drift: string[] = []
  for (const [name, contract] of Object.entries(derived)) {
    const stored = WIDGET_CONTRACTS[name]
    if (!stored) {
      drift.push(`${name}: missing from widget-contracts.ts`)
      continue
    }
    if (Boolean(stored.open) !== contract.open) drift.push(`${name}: open flag differs`)
    assert.deepEqual([...stored.props], contract.props, name)
  }
  for (const name of Object.keys(WIDGET_CONTRACTS)) {
    if (!derived[name]) drift.push(`${name}: in widget-contracts.ts but not in the registry`)
  }
  assert.deepEqual(drift, [])
})

/** Every `widget`/`widgetBlock`/`widgetCell` call in a view, with its props. */
function widgetCalls(file: string) {
  const source = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: Array<{ widget: string; props: string[]; analysable: boolean }> = []
  const visit = (node: TS.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['widget', 'widgetBlock', 'widgetCell'].includes(node.expression.text)
    ) {
      const [name, props] = node.arguments
      if (name && ts.isStringLiteralLike(name)) {
        if (!props) calls.push({ widget: name.text, props: [], analysable: true })
        else if (ts.isObjectLiteralExpression(props)) {
          const keys: string[] = []
          let analysable = true
          for (const property of props.properties) {
            if (ts.isSpreadAssignment(property)) { analysable = false; continue }
            const key = property.name
            if (key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) keys.push(key.text)
            else analysable = false
          }
          calls.push({ widget: name.text, props: keys, analysable })
        } else calls.push({ widget: name.text, props: [], analysable: false })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sf, visit)
  return calls
}

function views(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...views(full))
    else if (entry === 'view.ts') found.push(full)
  }
  return found
}

test("every prop the app's own pages pass is one its widget reads", () => {
  const files = views(APP_DIR)
  assert.ok(files.length > 150, `only found ${files.length} views`)

  const offenders: string[] = []
  let checked = 0
  for (const file of files) {
    for (const call of widgetCalls(file)) {
      const contract = WIDGET_CONTRACTS[call.widget]
      // `close-wizard-slot` is deliberately absent from the registry — see
      // the comment at its call site — so an unknown widget is not by itself
      // a failure here. `registry-names.test.ts` owns that question.
      if (!contract || contract.open || !call.analysable) continue
      for (const prop of call.props) {
        checked++
        if (!contract.props.includes(prop)) {
          offenders.push(`${call.widget} <- ${prop}   (${file.slice(ROOT.length)})`)
        }
      }
    }
  }
  // Without this the assertion below would pass on an empty walk, which is
  // exactly how a check like this stops checking anything.
  assert.ok(checked > 500, `only ${checked} props were compared`)
  assert.deepEqual(
    offenders,
    [],
    'these props reach nothing — either the widget should read them or the page should stop passing them',
  )
})
