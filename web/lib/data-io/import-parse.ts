/**
 * Provenance-preserving parsing for cell-embedded import payloads.
 *
 * PURE / client-safe: no db or server-only imports — the transaction import
 * resource uses this at its exact-decimal boundary and the unit tests exercise
 * it directly.
 */

/**
 * The largest object/array nesting parseImportJson accepts. Embedded payload
 * JSON (a transaction row's `lines` column) needs a handful of levels; the cap
 * turns adversarially deep documents into a clean SyntaxError instead of a
 * stack-overflow crash.
 */
const MAX_NESTING_DEPTH = 200

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isHexDigit(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')
}

/**
 * JSON.parse for cell-embedded import payloads (e.g. a transaction row's
 * `lines` column), with one deliberate difference: every unquoted number
 * token is returned as its SOURCE TEXT rather than an IEEE-754 double.
 *
 * JSON.parse collapses `{"amount":999999999999998.99}` into the integer-valued
 * double 999999999999999 before decimal validation ever sees it — silently
 * rounding the operator's digits, and doing so inside the server even though
 * the spreadsheet cell still holds the original text. Keeping the literal
 * token lets canonicalDecimal validate exactly what was typed, the same
 * guarantee quoted amounts and flat text columns already get (and it keeps
 * integers beyond 2^53 intact, which JSON.parse corrupts too).
 *
 * Strings, objects, arrays, and true/false/null behave exactly like
 * JSON.parse; duplicate keys are last-wins. Malformed input throws
 * SyntaxError with the failing position, so callers can treat this as a
 * drop-in for JSON.parse when number fidelity matters more than numeric
 * convenience.
 */
export function parseImportJson(text: string): unknown {
  let pos = 0

  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at position ${pos}`)
  }

  const skipWhitespace = () => {
    while (pos < text.length) {
      const code = text.charCodeAt(pos)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      pos++
    }
  }

  const parseString = (): string => {
    pos++ // opening quote
    let out = ''
    let chunkStart = pos
    for (;;) {
      if (pos >= text.length) fail('unterminated string')
      const code = text.charCodeAt(pos)
      if (code === 0x22) {
        out += text.slice(chunkStart, pos)
        pos++
        return out
      }
      if (code === 0x5c) {
        out += text.slice(chunkStart, pos)
        pos++
        if (pos >= text.length) fail('unterminated escape')
        const esc = text[pos]!
        switch (esc) {
          case '"': out += '"'; break
          case '\\': out += '\\'; break
          case '/': out += '/'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'u': {
            let hex = ''
            for (let i = 0; i < 4; i++) {
              const digit = text[pos + 1 + i]
              if (!isHexDigit(digit)) fail('invalid unicode escape')
              hex += digit
            }
            out += String.fromCharCode(parseInt(hex, 16))
            pos += 4
            break
          }
          default:
            fail(`invalid escape "\\${esc}"`)
        }
        pos++
        chunkStart = pos
        continue
      }
      if (code < 0x20) fail('unescaped control character in string')
      pos++
    }
  }

  /** Returns the token's source text — deliberately NOT a double. */
  const parseNumberToken = (): string => {
    const start = pos
    if (text[pos] === '-') pos++
    if (text[pos] === '0') {
      pos++
    } else if (isDigit(text[pos])) {
      while (isDigit(text[pos])) pos++
    } else {
      fail('invalid number')
    }
    if (text[pos] === '.') {
      pos++
      if (!isDigit(text[pos])) fail('digit expected after decimal point')
      while (isDigit(text[pos])) pos++
    }
    if (text[pos] === 'e' || text[pos] === 'E') {
      pos++
      if (text[pos] === '+' || text[pos] === '-') pos++
      if (!isDigit(text[pos])) fail('digit expected in exponent')
      while (isDigit(text[pos])) pos++
    }
    return text.slice(start, pos)
  }

  const parseLiteral = (word: string, value: unknown): unknown => {
    if (text.startsWith(word, pos)) {
      pos += word.length
      return value
    }
    return fail('invalid literal')
  }

  const setProperty = (target: Record<string, unknown>, key: string, value: unknown) => {
    if (key === '__proto__') {
      // JSON.parse creates __proto__ as an own data property; assignment would
      // swap the prototype instead, so mirror the spec here too.
      Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true })
      return
    }
    target[key] = value
  }

  const parseObject = (depth: number): Record<string, unknown> => {
    if (depth > MAX_NESTING_DEPTH) fail(`JSON nesting deeper than ${MAX_NESTING_DEPTH}`)
    pos++ // '{'
    const obj: Record<string, unknown> = {}
    skipWhitespace()
    if (text[pos] === '}') {
      pos++
      return obj
    }
    for (;;) {
      skipWhitespace()
      if (text[pos] !== '"') fail('string key expected')
      const key = parseString()
      skipWhitespace()
      if (text[pos] !== ':') fail("':' expected")
      pos++
      setProperty(obj, key, parseValue(depth + 1))
      skipWhitespace()
      if (text[pos] === ',') {
        pos++
        continue
      }
      if (text[pos] === '}') {
        pos++
        return obj
      }
      fail("',' or '}' expected")
    }
  }

  const parseArray = (depth: number): unknown[] => {
    if (depth > MAX_NESTING_DEPTH) fail(`JSON nesting deeper than ${MAX_NESTING_DEPTH}`)
    pos++ // '['
    const arr: unknown[] = []
    skipWhitespace()
    if (text[pos] === ']') {
      pos++
      return arr
    }
    for (;;) {
      arr.push(parseValue(depth + 1))
      skipWhitespace()
      if (text[pos] === ',') {
        pos++
        continue
      }
      if (text[pos] === ']') {
        pos++
        return arr
      }
      fail("',' or ']' expected")
    }
  }

  function parseValue(depth: number): unknown {
    skipWhitespace()
    if (pos >= text.length) fail('unexpected end of input')
    switch (text[pos]) {
      case '{': return parseObject(depth)
      case '[': return parseArray(depth)
      case '"': return parseString()
      case 't': return parseLiteral('true', true)
      case 'f': return parseLiteral('false', false)
      case 'n': return parseLiteral('null', null)
      default:
        if (text[pos] === '-' || isDigit(text[pos])) return parseNumberToken()
        fail(`unexpected character '${text[pos!]}'`)
    }
  }

  const value = parseValue(1)
  skipWhitespace()
  if (pos !== text.length) fail('unexpected trailing content')
  return value
}
