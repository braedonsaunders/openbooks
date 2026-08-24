import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import test from 'node:test'

/**
 * i18n sweep regression for the financial views that previously rendered
 * untranslated English copy.
 *
 * Every user-visible string in these audited views must come from next-intl
 * (`t(...)` / `getTranslations(...)`) rather than being hardcoded English. The
 * failure this catches is silent-by-nature: an untranslated string renders
 * perfectly in English and nothing fails until a non-English user opens that
 * exact screen.
 *
 * Detection is syntactic (TS AST), so it flags exactly what renders:
 *  - JSX text nodes containing words,
 *  - literals (string or template) inside known display props such as
 *    `title=`, `label=`, `placeholder=` — including ternary branches,
 *  - bare `{cond ? 'Yes' : 'No'}` expression children rendered as text.
 * Literals passed as arguments to a resolved `useTranslations()` /
 * `getTranslations()` variable are exempt, as are enum-ish literals that only
 * feed comparisons or styling (they never reach the DOM through these paths).
 */

const WORD = /[A-Za-z]{2}/

const FINANCIAL_VIEWS = [
  join(import.meta.dirname, '..', 'app', '(app)', 'analytics', 'true-cost', 'TrueCostView.tsx'),
  join(import.meta.dirname, '..', 'app', '(app)', 'banking', 'psp-settlements', 'page.tsx'),
] as const

const DISPLAY_ATTRS = new Set([
  'title', 'label', 'description', 'placeholder', 'hint', 'help',
  'helpLabel', 'subtitle', 'sub', 'emptyTitle', 'emptyDescription',
  'emptyLabel', 'buttonLabel', 'searchPlaceholder', 'statusMessage',
  'sheetTitle', 'alt', 'aria-label', 'ariaLabel', 'text', 'message',
])

/** Names bound to useTranslations()/getTranslations() results in this file. */
function translationNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const isTranslationFactory = (n: ts.Node): boolean =>
    ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
    /^(use|get)Translations$/.test(n.expression.text)
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      let init = n.initializer
      if (ts.isAwaitExpression(init)) init = init.expression
      if (
        ts.isCallExpression(init) && ts.isIdentifier(init.expression) &&
        /^(use|get)Translations$/.test(init.expression.text)
      ) {
        if (ts.isIdentifier(n.name)) names.add(n.name.text)
      } else if (ts.isArrayBindingPattern(n.name)) {
        // const [t, locale] = await Promise.all([getTranslations('ns'), …])
        let inner = init
        while (ts.isAwaitExpression(inner)) inner = inner.expression
        const calls: ts.CallExpression[] = []
        const scan = (m: ts.Node): void => {
          if (ts.isCallExpression(m)) calls.push(m)
          ts.forEachChild(m, scan)
        }
        scan(inner)
        if (calls.some(isTranslationFactory)) {
          for (const el of n.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.add(el.name.text)
          }
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return names
}

/**
 * Local i18n-wrapper helpers — `const label = (key, fallback) => t.has(key) ? t(key) : fallback`
 * and friends. Their string arguments are catalog keys plus safety-net
 * fallbacks, not hardcoded copy.
 */
function wrapperHelperNames(sf: ts.SourceFile, tNames: Set<string>): Set<string> {
  const names = new Set<string>()
  /** Named functions (e.g. useFilingText) whose body wires up a t.has wrapper. */
  const factories = new Set<string>()

  const bodyHasHas = (body: ts.Node): boolean => {
    let found = false
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) && n.name.text === 'has' &&
        ts.isIdentifier(n.expression) && tNames.has(n.expression.text)
      ) found = true
      ts.forEachChild(n, visit)
    }
    visit(body)
    return found
  }

  const unwrapUseCallback = (init: ts.Expression): ts.ConciseBody | undefined => {
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useCallback') {
      const fnArg = init.arguments[0]
      if (fnArg && (ts.isArrowFunction(fnArg) || ts.isFunctionExpression(fnArg))) return fnArg.body
    }
    return undefined
  }

  // Two passes: factories must be known before `const text = useFilingText()`.
  for (let pass = 0; pass < 2; pass++) {
    const visit = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && n.body && bodyHasHas(n.body)) {
        factories.add(n.name.text)
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        // Direct wrapper: const label = (key, fallback) => t.has(key) ? …
        if ((ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
          bodyHasHas(n.initializer.body)) {
          names.add(n.name.text)
        } else {
          const cbBody = unwrapUseCallback(n.initializer)
          if (cbBody && bodyHasHas(cbBody)) names.add(n.name.text)
          else if (
            ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) &&
            factories.has(n.initializer.expression.text)
          ) names.add(n.name.text)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return names
}

function isTranslationCall(node: ts.Node, tNames: Set<string>): boolean {
  if (!ts.isCallExpression(node)) return false
  const { expression } = node
  if (ts.isIdentifier(expression)) return tNames.has(expression.text)
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    // t.rich('key', {...}) and friends count as translated lookups.
    return tNames.has(expression.expression.text)
  }
  return false
}

/** True when this literal sits directly inside a t()/tc()/… argument list. */
function insideTranslationCall(node: ts.Node, tNames: Set<string>, helperNames: Set<string>): boolean {
  let cur = node.parent
  while (cur && !ts.isSourceFile(cur)) {
    if (isTranslationCall(cur, tNames)) return true
    // label('key', 'Fallback') / text('key', 'Fallback') wrapper helpers.
    if (
      ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) &&
      helperNames.has(cur.expression.text) &&
      cur.arguments.some((a) => a === node || isAncestor(a, node))
    ) return true
    cur = cur.parent
  }
  return false
}

function isAncestor(ancestor: ts.Node, node: ts.Node): boolean {
  let cur: ts.Node | undefined = node
  while (cur && cur !== ancestor) cur = cur.parent
  return cur === ancestor
}

function hasWords(text: string): boolean {
  return WORD.test(text)
}

/**
 * Locale-neutral technical tokens: single tokens made of identifiers,
 * paths, URLs, units, or ALL-CAPS labels ("SHA-256", "GET", "/inbound",
 * "backup-local-cli.ts", "ms", "https://…"). These render identically in
 * every language and must not block the sweep.
 */
function isTechnical(text: string): boolean {
  const tok = text.trim()
  if (!tok) return false
  // Entity-only text (&lt;, &amp;, …) decodes to symbols, not words.
  if (/^(?:&[a-zA-Z]+;\s*)+$/.test(tok)) return true
  // Code samples with UPPER_SNAKE interpolation tokens: {AR_IN} * IF({X}, 1)
  if (/^\s*\{?[A-Za-z0-9_]+\(?\{?[A-Za-z0-9_]+\}?.*$/.test(tok) && /\{[A-Z0-9_]+\}/.test(tok)) return true
  if (/^https?:\/\/\S+$/.test(tok)) return true
  // Unit symbols that follow numerals (ms, mm, pp, px): identical everywhere.
  if (/^(?:ms|mm|pp|px|pt|em|rem|vh|vw)$/.test(tok)) return true
  // URL path/query samples rendered as text: "/{id}", "?page=1&perPage=25".
  if (/^[/?][\w./=&?#{}%-]*$/.test(tok)) return true
  if (/\s/.test(tok)) return false
  if (/^[A-Z0-9/-]{1,8}$/.test(tok)) return true
  return (
    tok.length <= 32 &&
    /^[\w./:@#|+(),\u2026-]+$/.test(tok) &&
    /[\d._:/@#|+(),\u2026-]/.test(tok)
  )
}

/** Operators whose string operands feed comparisons, never the DOM. */
const COMPARISON_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
])

interface Violation { file: string; line: number; kind: string; snippet: string }

function scanFile(file: string): Violation[] {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const tNames = translationNames(sf)
  const wrapperNames = wrapperHelperNames(sf, tNames)
  const violations: Violation[] = []
  const lineOf = (node: ts.Node) =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const snippetOf = (node: ts.Node) => {
    const text = node.getText(sf).replace(/\s+/g, ' ')
    return text.length > 80 ? `${text.slice(0, 77)}...` : text
  }

  const flag = (node: ts.Node, kind: string, text: string): void => {
    if (!hasWords(text) || isTechnical(text) || insideTranslationCall(node, tNames, wrapperNames)) return
    violations.push({ file, line: lineOf(node), kind, snippet: snippetOf(node) })
  }

  const scanDisplayExpression = (attrName: string, expr: ts.Expression): void => {
    const visit = (n: ts.Node): void => {
      if (insideTranslationCall(n, tNames, wrapperNames)) return
      // Nested JSX inside a display prop is scanned by the main walk
      // (its text nodes and attributes); don't re-flag keys/classNames in it.
      if (ts.isJsxElement(n) || ts.isJsxFragment(n) || ts.isJsxSelfClosingElement(n)) return
      // Equality tests compare enum-ish literals; they never render.
      if (ts.isBinaryExpression(n) && COMPARISON_OPS.has(n.operatorToken.kind)) return
      if (ts.isStringLiteral(n)) flag(n, `:${attrName}`, n.text)
      else if (ts.isNoSubstitutionTemplateLiteral(n)) flag(n, `:${attrName}`, n.text)
      else if (ts.isTemplateExpression(n)) {
        if (hasWords(n.head.text)) flag(n.head, `:${attrName}`, n.head.text)
        for (const span of n.templateSpans) {
          if (hasWords(span.literal.text)) flag(span.literal, `:${attrName}`, span.literal.text)
        }
      } else ts.forEachChild(n, visit)
    }
    visit(expr)
  }

  /** A JSX child expression that renders a plain/ternary-of-strings literal. */
  const scanRenderedChild = (expr: ts.Expression): void => {
    if (ts.isParenthesizedExpression(expr)) return scanRenderedChild(expr.expression)
    if (ts.isConditionalExpression(expr)) {
      scanRenderedChild(expr.whenTrue)
      scanRenderedChild(expr.whenFalse)
    } else if (ts.isStringLiteral(expr)) flag(expr, '{child}', expr.text)
    else if (ts.isNoSubstitutionTemplateLiteral(expr)) flag(expr, '{child}', expr.text)
  }

  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      // Contents of <code>/<pre> are locale-neutral technical tokens
      // (formula identifiers, key names) — never natural-language copy.
      let p: ts.Node = n.parent ?? n
      while (ts.isJsxExpression(p) || ts.isJsxElement(p)) {
        if (ts.isJsxElement(p) && ts.isIdentifier(p.openingElement.tagName) &&
          ['code', 'pre'].includes(p.openingElement.tagName.text)) return
        if (!p.parent) return
        p = p.parent
      }
      flag(n, 'jsx-text', n.getText(sf))
    }
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && DISPLAY_ATTRS.has(n.name.text) && n.initializer) {
      if (ts.isStringLiteral(n.initializer)) flag(n.initializer, `:${n.name.text}`, n.initializer.text)
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) {
        scanDisplayExpression(n.name.text, n.initializer.expression)
      }
    }
    if (ts.isJsxExpression(n) && n.expression && n.parent && ts.isJsxElement(n.parent)) {
      scanRenderedChild(n.expression)
    }
    if (ts.isJsxExpression(n) && n.expression && n.parent && ts.isJsxFragment(n.parent)) {
      scanRenderedChild(n.expression)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return violations
}

test('true-cost and PSP settlement views render their copy through next-intl', () => {
  const offenders: string[] = []
  for (const f of FINANCIAL_VIEWS) for (const v of scanFile(f)) offenders.push(`${f}:${v.line} ${v.kind}: ${v.snippet}`)

  assert.deepEqual(
    offenders.map((o) => o.replace(/.*web\/app\//, '')),
    [],
    `${offenders.length} hardcoded strings remain in the audited financial views:\n${offenders.join('\n')}`,
  )
})

test('the sweep causally covers every audited financial view', () => {
  // A detector whose file list silently rots (a view moves, a glob stops
  // matching) passes forever while guarding nothing. Assert the audited
  // views exist and that each contributes real scanned surface.
  for (const f of FINANCIAL_VIEWS) {
    const src = readFileSync(f, 'utf8')
    assert.ok(src.includes('useTranslations'), `${f} must bind next-intl`)
    assert.ok(src.length > 5000, `${f} looks truncated — the sweep would guard nothing`)
  }
})
