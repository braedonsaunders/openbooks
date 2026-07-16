// The document template engine — merges org-authored HTML templates with
// record values. Ported from beaconhs-platform's email-render keystone; the
// grammar and safety model are identical:
//
//   {{ path }}            escaped value (path = key, this, this.key, a.b.c, @index…)
//   {{{ path }}}          raw (unescaped) value — for fields that hold trusted HTML
//   {{#each coll}}…{{/each}}       iterate an array
//   {{#if path}}…{{else}}…{{/if}}  conditional (empty array / 0 / '' / null = false)
//
// Safety model:
//   • Authored template HTML is sanitized ONCE at SAVE time via
//     `sanitizeTemplateHtml` — NOT on every render.
//   • Merge values are record DATA and are HTML-escaped at interpolation time
//     (`escapeHtml: true`), so render-time injection is impossible.
//   • The builder marks repeating table rows with `data-each="collection"` and
//     conditional rows with `data-if="path"`; `expandRepeatMarkers` expands
//     them into `{{#each}}` / `{{#if}}` blocks at compile time.

import DOMPurify from 'isomorphic-dompurify'

/** Hard resource ceilings for the synchronous render path. */
export const TEMPLATE_RENDER_LIMITS = {
  templateChars: 1_000_000,
  mergeValueChars: 1_000_000,
  renderOutputChars: 4_000_000,
  plainTextChars: 2_000_000,
  tokens: 20_000,
  astNodes: 20_000,
  nestingDepth: 32,
  loopIterations: 10_000,
  expressionChars: 256,
  hiddenHtmlDepth: 32,
} as const

function assertLength(value: string, max: number, label: string): void {
  if (value.length > max) {
    throw new Error(`${label} exceeded ${max} characters.`)
  }
}

class BoundedStringBuilder {
  readonly #chunks: string[] = []
  #pending: string[] = []
  #pendingLength = 0
  #length = 0

  constructor(
    private readonly max: number,
    private readonly label: string,
  ) {}

  get length(): number {
    return this.#length
  }

  append(value: string): void {
    if (!value) return
    if (this.#length > this.max - value.length) {
      throw new Error(`${this.label} exceeded ${this.max} characters.`)
    }
    // Coalesce the many single-character writes made by the HTML/entity
    // scanners — millions of one-character array entries would defeat the
    // memory ceiling even though the final string itself was bounded.
    if (value.length >= 8_192) {
      this.flushPending()
      this.#chunks.push(value)
    } else {
      this.#pending.push(value)
      this.#pendingLength += value.length
      if (this.#pendingLength >= 8_192) this.flushPending()
    }
    this.#length += value.length
  }

  toString(): string {
    const pending = this.#pending.join('')
    return this.#chunks.length === 0 ? pending : [...this.#chunks, pending].join('')
  }

  private flushPending(): void {
    if (this.#pendingLength > 0) this.#chunks.push(this.#pending.join(''))
    this.#pending = []
    this.#pendingLength = 0
  }
}

// --- HTML escaping -----------------------------------------------------------

export function escapeTemplateHtml(s: string): string {
  assertLength(s, TEMPLATE_RENDER_LIMITS.renderOutputChars, 'HTML value')
  const out = new BoundedStringBuilder(TEMPLATE_RENDER_LIMITS.renderOutputChars, 'Rendered output')
  for (let i = 0; i < s.length; i++) {
    const char = s[i]!
    if (char === '&') out.append('&amp;')
    else if (char === '<') out.append('&lt;')
    else if (char === '>') out.append('&gt;')
    else if (char === '"') out.append('&quot;')
    else out.append(char)
  }
  return out.toString()
}

// --- merge-value plainification ----------------------------------------------
//
// Merge values are record DATA, and long-text fields may hold HTML. Every
// substituted value is reduced to readable plain text before insertion;
// `{{{raw}}}` is the explicit opt-in for values that really are trusted HTML.

/** Stringify a merge value; if it looks like HTML, reduce it to plain text. */
export function plainValue(v: unknown): string {
  const s = v == null ? '' : String(v)
  assertLength(s, TEMPLATE_RENDER_LIMITS.mergeValueChars, 'Template merge value')
  return s.includes('<') || s.includes('&') ? htmlToPlainText(s) : s
}

// --- Block template engine ----------------------------------------------------

type Frame = { data: Record<string, unknown>; item?: unknown; meta?: Record<string, unknown> }

type TplNode =
  | { t: 'text'; v: string }
  | { t: 'var'; expr: string; raw: boolean }
  | { t: 'each'; expr: string; body: TplNode[] }
  | { t: 'if'; expr: string; body: TplNode[]; alt: TplNode[] }

type Tok =
  | { k: 'text'; v: string }
  | { k: 'var'; expr: string; raw: boolean }
  | { k: 'open'; block: 'each' | 'if'; expr: string }
  | { k: 'else' }
  | { k: 'close'; block: 'each' | 'if' }

function tokenize(tpl: string): Tok[] {
  assertLength(tpl, TEMPLATE_RENDER_LIMITS.templateChars, 'Document template')
  const toks: Tok[] = []
  const push = (token: Tok) => {
    if (toks.length >= TEMPLATE_RENDER_LIMITS.tokens) {
      throw new Error(`Document template exceeded ${TEMPLATE_RENDER_LIMITS.tokens} tokens.`)
    }
    toks.push(token)
  }

  let cursor = 0
  while (cursor < tpl.length) {
    const start = tpl.indexOf('{{', cursor)
    if (start === -1) {
      push({ k: 'text', v: tpl.slice(cursor) })
      break
    }
    if (start > cursor) push({ k: 'text', v: tpl.slice(cursor, start) })

    const raw = tpl.startsWith('{{{', start)
    const close = raw ? '}}}' : '}}'
    const contentStart = start + (raw ? 3 : 2)
    const end = tpl.indexOf(close, contentStart)
    if (end === -1) {
      // An unterminated marker is literal text.
      push({ k: 'text', v: tpl.slice(start) })
      break
    }

    const inner = tpl.slice(contentStart, end).trim()
    if (inner.length > TEMPLATE_RENDER_LIMITS.expressionChars) {
      throw new Error(
        `Document template expression exceeded ${TEMPLATE_RENDER_LIMITS.expressionChars} characters.`,
      )
    }

    if (raw) {
      push({ k: 'var', expr: inner, raw: true })
    } else if (inner === 'else') {
      push({ k: 'else' })
    } else if (inner === '/each') {
      push({ k: 'close', block: 'each' })
    } else if (inner === '/if') {
      push({ k: 'close', block: 'if' })
    } else if (inner.startsWith('/')) {
      throw new Error(`Document template contains an unsupported closing block "${inner}".`)
    } else {
      const eachPrefix = inner.slice(0, 5)
      const ifPrefix = inner.slice(0, 3)
      if (eachPrefix === '#each' && (inner.length === 5 || /\s/.test(inner[5]!))) {
        const expr = inner.slice(5).trim()
        if (!expr) throw new Error('Document template #each block requires a value path.')
        push({ k: 'open', block: 'each', expr })
      } else if (ifPrefix === '#if' && (inner.length === 3 || /\s/.test(inner[3]!))) {
        const expr = inner.slice(3).trim()
        if (!expr) throw new Error('Document template #if block requires a value path.')
        push({ k: 'open', block: 'if', expr })
      } else if (inner.startsWith('#')) {
        throw new Error(`Document template contains an unsupported block "${inner}".`)
      } else {
        push({ k: 'var', expr: inner, raw: false })
      }
    }
    cursor = end + close.length
  }
  return toks
}

type ParseState = { index: number; nodes: number }

function addNode(state: ParseState, nodes: TplNode[], node: TplNode): void {
  state.nodes += 1
  if (state.nodes > TEMPLATE_RENDER_LIMITS.astNodes) {
    throw new Error(`Document template exceeded ${TEMPLATE_RENDER_LIMITS.astNodes} syntax nodes.`)
  }
  nodes.push(node)
}

function parseBlock(
  toks: Tok[],
  state: ParseState,
  expected: 'each' | 'if' | null,
  depth: number,
  allowElse: boolean,
): TplNode[] {
  const nodes: TplNode[] = []
  while (state.index < toks.length) {
    const token = toks[state.index]!
    if (token.k === 'else') {
      if (expected !== 'if' || !allowElse) {
        throw new Error('Document template contains an unexpected {{else}} marker.')
      }
      return nodes
    }
    if (token.k === 'close') {
      if (token.block !== expected) {
        const wanted = expected ? `{{/${expected}}}` : 'no closing marker'
        throw new Error(`Document template found {{/${token.block}}}; expected ${wanted}.`)
      }
      return nodes
    }

    state.index += 1
    if (token.k === 'text') {
      addNode(state, nodes, { t: 'text', v: token.v })
    } else if (token.k === 'var') {
      addNode(state, nodes, { t: 'var', expr: token.expr, raw: token.raw })
    } else {
      if (depth >= TEMPLATE_RENDER_LIMITS.nestingDepth) {
        throw new Error(
          `Document template exceeded ${TEMPLATE_RENDER_LIMITS.nestingDepth} nested blocks.`,
        )
      }
      if (token.block === 'each') {
        const body = parseBlock(toks, state, 'each', depth + 1, false)
        const close = toks[state.index]
        if (close?.k !== 'close' || close.block !== 'each') {
          throw new Error('Document template contains an unclosed {{#each}} block.')
        }
        state.index += 1
        addNode(state, nodes, { t: 'each', expr: token.expr, body })
      } else {
        const body = parseBlock(toks, state, 'if', depth + 1, true)
        let alt: TplNode[] = []
        if (toks[state.index]?.k === 'else') {
          state.index += 1
          alt = parseBlock(toks, state, 'if', depth + 1, false)
        }
        const close = toks[state.index]
        if (close?.k !== 'close' || close.block !== 'if') {
          throw new Error('Document template contains an unclosed {{#if}} block.')
        }
        state.index += 1
        addNode(state, nodes, { t: 'if', expr: token.expr, body, alt })
      }
    }
  }

  if (expected) throw new Error(`Document template contains an unclosed {{#${expected}}} block.`)
  return nodes
}

function resolvePath(expr: string, stack: Frame[]): unknown {
  const path = expr.trim()
  if (path === 'this' || path === '.') return stack[stack.length - 1]?.item
  if (path.startsWith('@')) {
    const key = path.slice(1)
    for (let i = stack.length - 1; i >= 0; i--) {
      const meta = stack[i]?.meta
      if (meta && Object.prototype.hasOwnProperty.call(meta, key)) return meta[key]
    }
    return undefined
  }
  const parts = path.split('.')
  const head = parts[0] ?? ''
  let base: unknown
  if (head === 'this') {
    base = stack[stack.length - 1]?.item
  } else {
    for (let i = stack.length - 1; i >= 0; i--) {
      const d = stack[i]?.data
      if (d && typeof d === 'object' && Object.prototype.hasOwnProperty.call(d, head)) {
        base = d[head]
        break
      }
    }
  }
  for (const part of parts.slice(1)) {
    if (base == null || typeof base !== 'object') return undefined
    if (!Object.prototype.hasOwnProperty.call(base, part)) return undefined
    base = (base as Record<string, unknown>)[part]
  }
  return base
}

function isTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v == null || v === false) return false
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v)
  if (typeof v === 'string') return v.length > 0
  return true
}

type RenderState = {
  out: BoundedStringBuilder
  loopIterations: number
  escape: boolean
  allowRawValues: boolean
}

function renderNodes(nodes: TplNode[], stack: Frame[], state: RenderState): void {
  for (const n of nodes) {
    if (n.t === 'text') {
      state.out.append(n.v)
    } else if (n.t === 'var') {
      const v = resolvePath(n.expr, stack)
      const raw = n.raw && state.allowRawValues
      const value = raw ? (v == null ? '' : String(v)) : plainValue(v)
      if (raw) assertLength(value, TEMPLATE_RENDER_LIMITS.mergeValueChars, 'Raw template merge value')
      state.out.append(state.escape && !raw ? escapeTemplateHtml(value) : value)
    } else if (n.t === 'each') {
      const coll = resolvePath(n.expr, stack)
      if (Array.isArray(coll)) {
        for (let idx = 0; idx < coll.length; idx++) {
          state.loopIterations += 1
          if (state.loopIterations > TEMPLATE_RENDER_LIMITS.loopIterations) {
            throw new Error(
              `Document template exceeded ${TEMPLATE_RENDER_LIMITS.loopIterations} loop iterations.`,
            )
          }
          const item = coll[idx]
          stack.push({
            data: item && typeof item === 'object' ? (item as Record<string, unknown>) : {},
            item,
            meta: {
              index: idx,
              number: idx + 1,
              first: idx === 0,
              last: idx === coll.length - 1,
              length: coll.length,
            },
          })
          try {
            renderNodes(n.body, stack, state)
          } finally {
            stack.pop()
          }
        }
      }
    } else if (n.t === 'if') {
      renderNodes(isTruthy(resolvePath(n.expr, stack)) ? n.body : n.alt, stack, state)
    }
  }
}

/**
 * Render an authored template that may contain {{#each}} / {{#if}} blocks and
 * dotted paths, against `values`. When `escapeHtml` is set, substituted values
 * are escaped ({{{raw}}} opts a field out). Untrusted boundaries set
 * `allowRawValues: false`, which treats triple-brace values as escaped data too.
 */
export function renderTemplate(
  tpl: string,
  values: Record<string, unknown>,
  opts?: { escapeHtml?: boolean; allowRawValues?: boolean },
): string {
  assertLength(tpl, TEMPLATE_RENDER_LIMITS.templateChars, 'Document template')
  if (tpl.indexOf('{{') === -1) return tpl
  const tokens = tokenize(tpl)
  const parseState: ParseState = { index: 0, nodes: 0 }
  const nodes = parseBlock(tokens, parseState, null, 0, false)
  const renderState: RenderState = {
    out: new BoundedStringBuilder(TEMPLATE_RENDER_LIMITS.renderOutputChars, 'Rendered output'),
    loopIterations: 0,
    escape: opts?.escapeHtml ?? false,
    allowRawValues: opts?.allowRawValues ?? true,
  }
  renderNodes(nodes, [{ data: values, item: values }], renderState)
  return renderState.out.toString()
}

// --- Editable-builder markers → mustache (run at SAVE/compile) ----------------
//
// The visual builder can't author `{{#each}}` directly (the braces would show
// as literal text in the canvas and a table row can't carry text nodes between
// it). Instead the builder marks a repeating table row with
// `data-each="collection"` and a conditional row with `data-if="path"` — real,
// invisible HTML attributes that round-trip through GrapesJS. At compile we
// expand them into the `{{#each}}` / `{{#if}}` blocks the renderer handles.

type RepeatMarker = {
  block: 'each' | 'if'
  expr: string
  removeStart: number
  removeEnd: number
}

function isHtmlSpace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

function assertTemplatePath(path: string): void {
  if (!path || path.length > TEMPLATE_RENDER_LIMITS.expressionChars) {
    throw new Error('Repeat marker contains an invalid value path.')
  }
  const parts = path.split('.')
  for (const part of parts) {
    if (!part) throw new Error('Repeat marker contains an invalid value path.')
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i)
      const allowed =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        code === 95 ||
        (code >= 97 && code <= 122)
      if (!allowed) throw new Error('Repeat marker contains an invalid value path.')
    }
  }
}

function readRepeatMarker(openTag: string): RepeatMarker | null {
  let cursor = 3 // immediately after "<tr"
  let marker: RepeatMarker | null = null

  while (cursor < openTag.length) {
    const whitespaceStart = cursor
    while (cursor < openTag.length && isHtmlSpace(openTag.charCodeAt(cursor))) cursor += 1
    if (openTag[cursor] === '>' || openTag[cursor] === '/') break

    const nameStart = cursor
    while (cursor < openTag.length) {
      const code = openTag.charCodeAt(cursor)
      const isName =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        code === 45 ||
        code === 58 ||
        code === 95 ||
        (code >= 97 && code <= 122)
      if (!isName) break
      cursor += 1
    }
    if (cursor === nameStart) {
      cursor += 1
      continue
    }
    const name = openTag.slice(nameStart, cursor).toLowerCase()
    while (cursor < openTag.length && isHtmlSpace(openTag.charCodeAt(cursor))) cursor += 1

    let value: string | null = null
    if (openTag[cursor] === '=') {
      cursor += 1
      while (cursor < openTag.length && isHtmlSpace(openTag.charCodeAt(cursor))) cursor += 1
      const quote = openTag[cursor]
      if (quote === '"' || quote === "'") {
        cursor += 1
        const valueStart = cursor
        while (cursor < openTag.length && openTag[cursor] !== quote) cursor += 1
        if (cursor >= openTag.length) {
          throw new Error('Repeat marker contains an unterminated attribute value.')
        }
        value = openTag.slice(valueStart, cursor)
        cursor += 1
      } else {
        const valueStart = cursor
        while (
          cursor < openTag.length &&
          !isHtmlSpace(openTag.charCodeAt(cursor)) &&
          openTag[cursor] !== '>'
        ) {
          cursor += 1
        }
        value = openTag.slice(valueStart, cursor)
      }
    }

    if (name === 'data-each' || name === 'data-if') {
      if (marker) throw new Error('A table row contains more than one repeat marker.')
      const expr = value?.trim() ?? ''
      assertTemplatePath(expr)
      marker = {
        block: name === 'data-each' ? 'each' : 'if',
        expr,
        removeStart: whitespaceStart,
        removeEnd: cursor,
      }
    }
  }

  return marker
}

/**
 * Expand `data-each` / `data-if` builder markers into mustache blocks:
 *   <tr data-each="lines">…</tr>   → {{#each lines}}<tr>…</tr>{{/each}}
 *   <tr data-if="memo">…</tr>      → {{#if memo}}<tr>…</tr>{{/if}}
 * Only `<tr>` is supported. A quote-aware linear scanner pairs each marked row
 * with its closing tag and rejects invalid nested rows. The marker attribute
 * is stripped from the emitted row.
 */
export function expandRepeatMarkers(html: string): string {
  assertLength(html, TEMPLATE_RENDER_LIMITS.templateChars, 'Document template')
  const operations: { start: number; end: number; value: string }[] = []
  let active:
    | {
        marker: RepeatMarker
        openStart: number
        openEnd: number
        openTag: string
      }
    | undefined
  let cursor = 0

  while (cursor < html.length) {
    const start = html.indexOf('<', cursor)
    if (start === -1) break
    const tag = readHtmlTag(html, start)
    if (!tag) {
      cursor = start + 1
      continue
    }
    cursor = tag.end
    if (tag.name !== 'tr') continue

    if (!tag.closing) {
      if (active) throw new Error('Repeat rows must not contain nested table rows.')
      const openTag = html.slice(start, tag.end)
      const marker = readRepeatMarker(openTag)
      if (marker) {
        if (tag.selfClosing) throw new Error('Repeat row must have a closing </tr> tag.')
        active = { marker, openStart: start, openEnd: tag.end, openTag }
      }
      continue
    }

    if (active) {
      const { marker, openStart, openEnd, openTag } = active
      const withoutMarker = openTag.slice(0, marker.removeStart) + openTag.slice(marker.removeEnd)
      operations.push({
        start: openStart,
        end: openEnd,
        value: `{{#${marker.block} ${marker.expr}}}${withoutMarker}`,
      })
      operations.push({
        start: tag.end,
        end: tag.end,
        value: `{{/${marker.block}}}`,
      })
      active = undefined
    }
  }

  if (active) throw new Error('Repeat row must have a closing </tr> tag.')
  if (operations.length === 0) return html

  const out = new BoundedStringBuilder(
    TEMPLATE_RENDER_LIMITS.renderOutputChars,
    'Expanded document template',
  )
  cursor = 0
  for (const operation of operations) {
    out.append(html.slice(cursor, operation.start))
    out.append(operation.value)
    cursor = operation.end
  }
  out.append(html.slice(cursor))
  return out.toString()
}

// --- HTML scanning helpers -----------------------------------------------------

const HIDDEN_TEXT_TAGS = new Set(['head', 'style', 'script', 'noscript'])
const LINE_BREAK_TAGS = new Set(['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'table'])

type HtmlTag = {
  end: number
  name: string | null
  closing: boolean
  selfClosing: boolean
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isHtmlNameCode(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45 || code === 58
}

/** Read one HTML tag without treating a `>` inside a quoted attribute as its end. */
function readHtmlTag(html: string, start: number): HtmlTag | null {
  if (html.charCodeAt(start) !== 60) return null
  if (html.startsWith('<!--', start)) {
    const end = html.indexOf('-->', start + 4)
    return {
      end: end === -1 ? html.length : end + 3,
      name: null,
      closing: false,
      selfClosing: false,
    }
  }

  let cursor = start + 1
  let closing = false
  if (html.charCodeAt(cursor) === 47) {
    closing = true
    cursor += 1
  }
  while (cursor < html.length) {
    const code = html.charCodeAt(cursor)
    if (code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 32) break
    cursor += 1
  }

  const first = html.charCodeAt(cursor)
  const declaration = first === 33 || first === 63
  if (!declaration && !isAsciiLetter(first)) return null

  const nameStart = cursor
  if (declaration) {
    cursor += 1
  } else {
    while (cursor < html.length && isHtmlNameCode(html.charCodeAt(cursor))) cursor += 1
  }
  const name = declaration ? null : html.slice(nameStart, cursor).toLowerCase()
  let quote = 0
  let lastNonWhitespace = 0
  for (; cursor < html.length; cursor++) {
    const code = html.charCodeAt(cursor)
    if (quote) {
      if (code === quote) quote = 0
      continue
    }
    if (code === 34 || code === 39) {
      quote = code
      continue
    }
    if (code === 62) {
      return {
        end: cursor + 1,
        name,
        closing,
        selfClosing: lastNonWhitespace === 47,
      }
    }
    if (code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 32) {
      lastNonWhitespace = code
    }
  }

  // A recognized unterminated tag is not readable body text.
  return { end: html.length, name, closing, selfClosing: false }
}

function decodeNumericEntity(entity: string, radix: 10 | 16): string | null {
  const start = radix === 16 ? 2 : 1
  if (entity.length === start || entity.length - start > 7) return null
  let value = 0
  for (let i = start; i < entity.length; i++) {
    const code = entity.charCodeAt(i)
    let digit = -1
    if (code >= 48 && code <= 57) digit = code - 48
    else if (radix === 16 && code >= 65 && code <= 70) digit = code - 55
    else if (radix === 16 && code >= 97 && code <= 102) digit = code - 87
    if (digit < 0 || digit >= radix) return null
    value = value * radix + digit
  }
  if (value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '�'
  return String.fromCodePoint(value)
}

function decodeEntityAt(html: string, start: number): { value: string; next: number } | null {
  const maxEnd = Math.min(html.length, start + 18)
  let semicolon = -1
  for (let i = start + 1; i < maxEnd; i++) {
    if (html.charCodeAt(i) === 59) {
      semicolon = i
      break
    }
  }
  if (semicolon === -1) return null

  const entity = html.slice(start + 1, semicolon)
  const lower = entity.toLowerCase()
  let value: string | null = null
  if (lower === 'amp') value = '&'
  else if (lower === 'lt') value = '<'
  else if (lower === 'gt') value = '>'
  else if (lower === 'quot') value = '"'
  else if (lower === 'apos' || lower === '#39') value = "'"
  else if (lower === 'nbsp') value = ' '
  else if (lower.startsWith('#x')) value = decodeNumericEntity(lower, 16)
  else if (lower.startsWith('#')) value = decodeNumericEntity(lower, 10)
  return value == null ? null : { value, next: semicolon + 1 }
}

class PlainTextBuilder {
  readonly #out = new BoundedStringBuilder(
    TEMPLATE_RENDER_LIMITS.plainTextChars,
    'Plain-text output',
  )
  #pendingSpace = false
  #pendingNewlines = 0
  #previousWasCarriageReturn = false

  append(value: string): void {
    for (const char of value) {
      if (char === '\r') {
        this.queueLineBreak()
        this.#previousWasCarriageReturn = true
      } else if (char === '\n') {
        if (!this.#previousWasCarriageReturn) this.queueLineBreak()
        this.#previousWasCarriageReturn = false
      } else if (char === ' ' || char === '\t' || char === '\f') {
        this.#previousWasCarriageReturn = false
        this.#pendingSpace = this.#out.length > 0 || this.#pendingNewlines > 0
      } else {
        this.#previousWasCarriageReturn = false
        if (this.#pendingNewlines > 0 && this.#out.length > 0) {
          this.#out.append('\n'.repeat(this.#pendingNewlines))
        } else if (this.#pendingSpace && this.#out.length > 0) {
          this.#out.append(' ')
        }
        this.#pendingSpace = false
        this.#pendingNewlines = 0
        this.#out.append(char)
      }
    }
  }

  lineBreak(): void {
    this.#previousWasCarriageReturn = false
    this.queueLineBreak()
  }

  private queueLineBreak(): void {
    this.#pendingSpace = false
    if (this.#out.length > 0) this.#pendingNewlines = Math.min(2, this.#pendingNewlines + 1)
  }

  toString(): string {
    return this.#out.toString()
  }
}

/** Derive readable plain text from HTML (used to plainify HTML-bearing values). */
export function htmlToPlainText(html: string): string {
  assertLength(html, TEMPLATE_RENDER_LIMITS.renderOutputChars, 'Rendered HTML')
  const out = new PlainTextBuilder()
  const hidden: string[] = []
  let cursor = 0

  while (cursor < html.length) {
    const code = html.charCodeAt(cursor)
    if (code === 60) {
      const tag = readHtmlTag(html, cursor)
      if (tag) {
        cursor = tag.end
        if (!tag.name) continue

        if (hidden.length > 0) {
          if (tag.closing) {
            const index = hidden.lastIndexOf(tag.name)
            if (index !== -1) hidden.length = index
          } else if (!tag.selfClosing && HIDDEN_TEXT_TAGS.has(tag.name)) {
            if (hidden.length >= TEMPLATE_RENDER_LIMITS.hiddenHtmlDepth) {
              throw new Error(
                `Rendered HTML exceeded ${TEMPLATE_RENDER_LIMITS.hiddenHtmlDepth} nested hidden elements.`,
              )
            }
            hidden.push(tag.name)
          }
          continue
        }

        if (!tag.closing && !tag.selfClosing && HIDDEN_TEXT_TAGS.has(tag.name)) {
          out.append(' ')
          hidden.push(tag.name)
        } else if (
          (!tag.closing && tag.name === 'br') ||
          (tag.closing && LINE_BREAK_TAGS.has(tag.name))
        ) {
          out.lineBreak()
        }
        continue
      }
    }

    if (hidden.length > 0) {
      cursor += 1
      continue
    }
    if (code === 38) {
      const entity = decodeEntityAt(html, cursor)
      if (entity) {
        out.append(entity.value)
        cursor = entity.next
        continue
      }
    }
    out.append(html[cursor]!)
    cursor += 1
  }

  return out.toString()
}

// --- Sanitization (run at SAVE/compile time) -----------------------------------

/**
 * Sanitize authored template HTML. Loosens DOMPurify's defaults for the
 * tags/attrs print documents need (full document, <style>, tables, bgcolor/…)
 * while keeping its safe-by-default stripping of <script>, event handlers, and
 * javascript: URIs. Idempotent — safe to run again on read.
 *
 * ORDER MATTERS: sanitize BEFORE expandRepeatMarkers. DOMPurify parses the
 * document, and the HTML parser foster-parents loose text out of <table>
 * content — an already-expanded `{{#each}}<tr>…</tr>{{/each}}` block gets its
 * braces hoisted after the table, silently breaking every repeat row. The
 * builder's `data-each` / `data-if` row markers are attributes, which survive
 * parsing — so they are allow-listed here and expanded afterwards.
 */
const SANITIZE_TEMPLATE_OPTIONS = {
  ADD_TAGS: ['style', 'meta', 'link', 'title', 'head', 'body', 'html', 'center'],
  ADD_ATTR: [
    'style',
    'class',
    'bgcolor',
    'background',
    'align',
    'valign',
    'width',
    'height',
    'border',
    'cellpadding',
    'cellspacing',
    'colspan',
    'rowspan',
    'dir',
    'lang',
    'role',
    'target',
    // The row-repeat / conditional-row markers (see expandRepeatMarkers).
    'data-each',
    'data-if',
  ],
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea'],
  ALLOW_DATA_ATTR: false,
}

function sanitizeMarkup(html: string, wholeDocument: boolean): string {
  assertLength(html, TEMPLATE_RENDER_LIMITS.templateChars, 'Authored template HTML')
  const sanitized = String(
    DOMPurify.sanitize(html, {
      ...SANITIZE_TEMPLATE_OPTIONS,
      WHOLE_DOCUMENT: wholeDocument,
    }),
  )
  assertLength(sanitized, TEMPLATE_RENDER_LIMITS.renderOutputChars, 'Sanitized template HTML')
  return sanitized
}

export function sanitizeTemplateHtml(html: string): string {
  return sanitizeMarkup(html, true)
}

/** Sanitize an embeddable fragment without adding document wrappers. */
export function sanitizeTemplateFragment(html: string): string {
  return sanitizeMarkup(html, false)
}

function assertTemplateTokensAreTextOnly(html: string): void {
  let cursor = 0
  let inStyle = false
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor)
    const textEnd = start === -1 ? html.length : start
    if (inStyle && html.slice(cursor, textEnd).includes('{{')) {
      throw new Error('Template tokens are only allowed in visible body text.')
    }
    if (start === -1) break

    const tag = readHtmlTag(html, start)
    if (!tag) {
      cursor = start + 1
      continue
    }
    const rawTag = html.slice(start, tag.end)
    if (rawTag.includes('{{')) {
      throw new Error('Template tokens are only allowed in visible body text.')
    }
    if (tag.name === 'style') inStyle = !tag.closing && !tag.selfClosing
    cursor = tag.end
  }
}

/**
 * Sanitize a tokenized header/footer fragment and prove that every token is in
 * text content — a record value can never become a URL, CSS, or attribute.
 */
export function sanitizeTokenizedFragment(html: string): string {
  const sanitized = sanitizeTemplateFragment(html)
  assertTemplateTokensAreTextOnly(sanitized)
  return sanitized
}

/**
 * Compile authored builder HTML for storage: sanitize (keeping the
 * data-each/data-if markers), then expand the markers into mustache blocks.
 * Returns both the sanitized source (reloaded by the builder) and the
 * compiled HTML (merged at render time).
 */
export function compileTemplateHtml(sourceHtml: string): {
  sanitizedSource: string
  compiledHtml: string
} {
  const sanitizedSource = sanitizeTemplateHtml(sourceHtml)
  return { sanitizedSource, compiledHtml: expandRepeatMarkers(sanitizedSource) }
}
