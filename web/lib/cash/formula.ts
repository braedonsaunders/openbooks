/**
 * Safe Excel-style formula evaluator — a faithful implementation of'
 * Lib_Core.evaluateFormula/tokenizeFormula (recursive descent, no eval).
 * Supports ternary (? :), || &&, == !=, < <= > >=, + - * / %, unary ! + -,
 * parens, and the functions min/max/ceil/floor/round/sqrt/pow/abs/avg.
 * Division and modulo by zero return 0 (defined semantics).
 */

type Token =
  | { type: 'number'; value: number }
  | { type: 'identifier'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'paren'; value: string }
  | { type: 'comma'; value: string }

function tokenizeFormula(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    const twoChar = source.substring(index, index + 2)
    if (['>=', '<=', '==', '!=', '&&', '||'].includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar })
      index += 2
      continue
    }
    if ('+-*/%?:><!'.includes(char)) {
      tokens.push({ type: 'operator', value: char })
      index += 1
      continue
    }
    if (char === '(' || char === ')') {
      tokens.push({ type: 'paren', value: char })
      index += 1
      continue
    }
    if (char === ',') {
      tokens.push({ type: 'comma', value: char })
      index += 1
      continue
    }
    if (/[0-9.]/.test(char)) {
      let end = index + 1
      while (end < source.length && /[0-9.]/.test(source[end]!)) end += 1
      const number = parseFloat(source.substring(index, end))
      if (!isFinite(number)) throw new Error('Invalid numeric token in formula')
      tokens.push({ type: 'number', value: number })
      index = end
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1
      tokens.push({ type: 'identifier', value: source.substring(index, end) })
      index = end
      continue
    }
    throw new Error('Unsupported character in formula')
  }
  return tokens
}

type Value = number | boolean
const toNumber = (v: Value): number => (typeof v === 'boolean' ? (v ? 1 : 0) : v)
const toBoolean = (v: Value): boolean => (typeof v === 'boolean' ? v : v !== 0)

function executeFormulaFunction(name: string, args: Value[]): number {
  const n = args.map(toNumber)
  switch (name) {
    case 'min': return n.length ? Math.min(...n) : 0
    case 'max': return n.length ? Math.max(...n) : 0
    case 'ceil': return Math.ceil(n[0] ?? 0)
    case 'floor': return Math.floor(n[0] ?? 0)
    case 'round': return Math.round(n[0] ?? 0)
    case 'sqrt': return Math.sqrt(n[0] ?? 0)
    case 'pow': return Math.pow(n[0] ?? 0, n[1] ?? 0)
    case 'abs': return Math.abs(n[0] ?? 0)
    case 'avg': return n.length ? n.reduce((s, v) => s + v, 0) / n.length : 0
    default: throw new Error(`Unsupported formula function: ${name}`)
  }
}

export function evaluateFormula(expression: string): number {
  const source = String(expression || '').trim()
  if (!source) throw new Error('Formula is empty')

  const tokens = tokenizeFormula(source)
  let position = 0

  const peek = () => tokens[position]
  const advance = () => tokens[position++]
  const match = (type: Token['type'], value?: string): boolean => {
    const token = peek()
    if (!token || token.type !== type) return false
    if (value !== undefined && token.value !== value) return false
    position += 1
    return true
  }
  const expect = (type: Token['type'], value?: string): Token => {
    const token = advance()
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error('Unexpected token in formula')
    }
    return token
  }

  function parseExpression(): Value {
    return parseTernary()
  }
  function parseTernary(): Value {
    const condition = parseLogicalOr()
    if (match('operator', '?')) {
      const whenTrue = parseExpression()
      expect('operator', ':')
      const whenFalse = parseExpression()
      return toBoolean(condition) ? whenTrue : whenFalse
    }
    return condition
  }
  function parseLogicalOr(): Value {
    let value = parseLogicalAnd()
    while (match('operator', '||')) value = toBoolean(value) || toBoolean(parseLogicalAnd())
    return value
  }
  function parseLogicalAnd(): Value {
    let value = parseEquality()
    while (match('operator', '&&')) value = toBoolean(value) && toBoolean(parseEquality())
    return value
  }
  function parseEquality(): Value {
    let value = parseComparison()
    for (;;) {
      if (match('operator', '==')) value = toNumber(value) === toNumber(parseComparison())
      else if (match('operator', '!=')) value = toNumber(value) !== toNumber(parseComparison())
      else return value
    }
  }
  function parseComparison(): Value {
    let value = parseAdditive()
    for (;;) {
      if (match('operator', '>=')) value = toNumber(value) >= toNumber(parseAdditive())
      else if (match('operator', '<=')) value = toNumber(value) <= toNumber(parseAdditive())
      else if (match('operator', '>')) value = toNumber(value) > toNumber(parseAdditive())
      else if (match('operator', '<')) value = toNumber(value) < toNumber(parseAdditive())
      else return value
    }
  }
  function parseAdditive(): Value {
    let value = parseMultiplicative()
    for (;;) {
      if (match('operator', '+')) value = toNumber(value) + toNumber(parseMultiplicative())
      else if (match('operator', '-')) value = toNumber(value) - toNumber(parseMultiplicative())
      else return value
    }
  }
  function parseMultiplicative(): Value {
    let value = parseUnary()
    for (;;) {
      if (match('operator', '*')) value = toNumber(value) * toNumber(parseUnary())
      else if (match('operator', '/')) {
        const divisor = toNumber(parseUnary())
        value = divisor === 0 ? 0 : toNumber(value) / divisor
      } else if (match('operator', '%')) {
        const divisor = toNumber(parseUnary())
        value = divisor === 0 ? 0 : toNumber(value) % divisor
      } else return value
    }
  }
  function parseUnary(): Value {
    if (match('operator', '!')) return !toBoolean(parseUnary())
    if (match('operator', '+')) return toNumber(parseUnary())
    if (match('operator', '-')) return -toNumber(parseUnary())
    return parsePrimary()
  }
  function parsePrimary(): Value {
    const token = peek()
    if (!token) throw new Error('Unexpected end of formula')
    if (match('number')) return (token as { value: number }).value
    if (match('identifier')) {
      const name = (token as { value: string }).value.toLowerCase()
      if (match('paren', '(')) {
        const args: Value[] = []
        if (!match('paren', ')')) {
          do {
            args.push(parseExpression())
          } while (match('comma'))
          expect('paren', ')')
        }
        return executeFormulaFunction(name, args)
      }
      if (name === 'true') return 1
      if (name === 'false') return 0
      throw new Error(`Unsupported formula token: ${(token as { value: string }).value}`)
    }
    if (match('paren', '(')) {
      const value = parseExpression()
      expect('paren', ')')
      return value
    }
    throw new Error('Unexpected token in formula')
  }

  const result = parseExpression()
  if (position !== tokens.length) throw new Error('Unexpected trailing formula content')
  return toNumber(result)
}
