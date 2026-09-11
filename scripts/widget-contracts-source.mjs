/**
 * Read each widget's prop contract out of the registry that renders it.
 *
 * A stored layout is validated against the closed schema and against the
 * registry NAMES, which proves a widget exists and stops nothing else: props
 * are `Record<string, unknown>` by design, so `placeholer` for `placeholder`
 * is accepted, stored, and then silently ignored at render. The author sees a
 * page missing the thing they just set and no message anywhere.
 *
 * The names a widget actually reads are already written down — in the widget's
 * own registry entry — so they are read from there rather than transcribed
 * into a second list that would drift. A transcribed contract is worse than
 * none: it eventually rejects props that work.
 *
 * Parsed with the TypeScript AST rather than regexes. The entries are ordinary
 * TSX with several ways to reach a prop (`str(props, 'x')`, `props.x as T`,
 * `props.x === true`), and a regex that missed one would produce a contract
 * that refuses a working layout — the exact failure this must not have.
 *
 * A widget whose props cannot be enumerated with certainty is marked OPEN and
 * checked for nothing. Seventeen entries forward props wholesale; guessing at
 * those would trade a silent typo for a confident false refusal.
 */
import { createRequire } from 'node:module'

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url))
const ts = requireFromWeb('typescript')

/**
 * Prop keys read by one registry entry.
 *
 * Returns `open: true` when the entry does anything this cannot follow — a
 * spread, a computed key, or handing `props` to something else — because from
 * that point on any prop name might be meaningful.
 */
export function entryContract(node) {
  const props = new Set()
  let open = false

  // The parameter the entry calls its props object. `() => <X />` takes none,
  // so it reads nothing and is closed with an empty set.
  const param = node.parameters?.[0]
  if (!param) return { props: [], open: false }
  if (!ts.isIdentifier(param.name)) {
    // Destructured props (`({ a, b }) => …`). The names ARE the contract.
    if (ts.isObjectBindingPattern(param.name)) {
      for (const element of param.name.elements) {
        if (element.dotDotDotToken) open = true
        else if (ts.isIdentifier(element.propertyName ?? element.name)) {
          props.add((element.propertyName ?? element.name).text)
        }
      }
      return { props: [...props].sort(), open }
    }
    return { props: [], open: true }
  }
  const name = param.name.text

  const visit = (child) => {
    // `props.x`
    if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) {
      props.add(child.name.text)
      return
    }
    // `props['x']` — and `props[expr]`, which cannot be enumerated.
    if (ts.isElementAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) {
      if (ts.isStringLiteralLike(child.argumentExpression)) props.add(child.argumentExpression.text)
      else open = true
      return
    }
    // `str(props, 'x')`, `num(props, 'x')`, `stringRecord(props, 'x')` — any
    // helper whose first argument is the props object and second a literal.
    if (ts.isCallExpression(child)) {
      const [first, second] = child.arguments
      if (first && ts.isIdentifier(first) && first.text === name) {
        if (second && ts.isStringLiteralLike(second)) {
          props.add(second.text)
          // Keep walking the REST of the arguments; only the two matched
          // above are accounted for.
          for (const argument of child.arguments.slice(2)) ts.forEachChild(argument, visit)
          return
        }
        // `props` passed somewhere this cannot follow.
        open = true
      }
    }
    // `{...props}` in JSX, or `...props` in an object literal.
    if (
      (ts.isJsxSpreadAttribute(child) || ts.isSpreadAssignment(child) || ts.isSpreadElement(child)) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === name
    ) {
      open = true
      return
    }
    // A bare mention of `props` that is not one of the shapes above means it
    // escaped into something opaque.
    if (ts.isIdentifier(child) && child.text === name) open = true

    ts.forEachChild(child, visit)
  }
  // The BODY only. Walking the whole function would visit its own parameter,
  // a bare `props` identifier, and mark every widget open.
  if (node.body) visit(node.body)

  return { props: [...props].sort(), open }
}

/** Every `'name': (props) => …` entry in a registry object literal. */
export function registryContracts(source, declaration) {
  const file = ts.createSourceFile('widgets.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let literal = null
  const find = (node) => {
    if (literal) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === declaration &&
      node.initializer
    ) {
      // `X: Record<…> = { … }` — the initializer may be wrapped in `as`.
      let init = node.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression
      if (ts.isObjectLiteralExpression(init)) literal = init
    }
    ts.forEachChild(node, find)
  }
  ts.forEachChild(file, find)
  if (!literal) throw new Error(`could not find the ${declaration} object literal`)

  const contracts = {}
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) {
      // A shorthand or spread inside the registry itself would mean entries
      // this cannot see; refuse rather than silently under-report.
      throw new Error('the widget registry must be a literal of `name: renderer` pairs')
    }
    const key = ts.isStringLiteralLike(property.name) || ts.isIdentifier(property.name)
      ? property.name.text
      : null
    if (key === null) throw new Error('a widget entry has a computed name')
    const fn = property.initializer
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
      // Not a function literal — its props cannot be read here.
      contracts[key] = { props: [], open: true }
      continue
    }
    contracts[key] = entryContract(fn)
  }
  return contracts
}

export function generate(contracts) {
  const entries = Object.keys(contracts)
    .sort()
    .map((name) => {
      const { props, open } = contracts[name]
      const list = props.map((prop) => `'${prop}'`).join(', ')
      return `  '${name}': { props: [${list}]${open ? ', open: true' : ''} },`
    })

  return `// GENERATED by scripts/generate-widget-contracts.mjs — do not edit by hand.
// Regenerate after changing a widget's props; web/components/viewspec/widget-contracts.test.ts
// re-derives these from source and fails if this file has drifted.

export interface WidgetContract {
  /** Prop names the widget reads. A name outside this list reaches nothing. */
  props: readonly string[]
  /**
   * The widget forwards its props wholesale, so any name may be meaningful
   * and none can be refused. Checked for nothing on purpose: a confident
   * false refusal is worse than the silent typo it would replace.
   */
  open?: true
}

export const WIDGET_CONTRACTS: Readonly<Record<string, WidgetContract>> = {
${entries.join('\n')}
}
`
}
