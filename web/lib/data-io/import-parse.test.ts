import assert from 'node:assert/strict'
import test from 'node:test'
import { parseImportJson } from './import-parse.ts'

const syntaxError = (text: string): SyntaxError => {
  try {
    parseImportJson(text)
  } catch (e) {
    assert.ok(e instanceof SyntaxError, `expected SyntaxError, got ${String(e)}`)
    return e
  }
  throw new Error(`expected parseImportJson(${JSON.stringify(text)}) to throw`)
}

test('unquoted number tokens keep their exact source text', () => {
  const parsed = parseImportJson('[{"account":"5000","amount":999999999999998.99}]') as {
    account: string
    amount: string
  }[]
  assert.deepEqual(parsed, [{ account: '5000', amount: '999999999999998.99' }])
})

test('number tokens survive as source text where JSON.parse would corrupt them', () => {
  const parsed = parseImportJson(
    '[{"a":100.25,"b":-0,"c":1e3,"d":1E+3,"e":0.100000,"f":9007199254740993,"g":-12.5,"h":0,"i":0.5e-2}]',
  ) as Record<string, string>[]
  assert.deepEqual(parsed, [
    {
      a: '100.25',
      b: '-0',
      c: '1e3',
      d: '1E+3',
      e: '0.100000',
      f: '9007199254740993',
      g: '-12.5',
      h: '0',
      i: '0.5e-2',
    },
  ])
})

test('quoted values stay strings and structural types match JSON.parse', () => {
  const text = '{"s":"123.45","t":"x","b":true,"f":false,"n":null,"arr":[],"obj":{}}'
  assert.deepEqual(parseImportJson(text), JSON.parse(text))
  assert.deepEqual(parseImportJson('  [\r\n\t 1 , 2 ]  '), ['1', '2'])
})

test('strings preserve escapes exactly like JSON.parse', () => {
  for (const text of [
    '"line\\nbreak"',
    '"quote\\"inside"',
    '"back\\\\slash"',
    '"slash/"',
    '"\\u00e9\\ud83d\\ude00"',
  ]) {
    assert.equal(parseImportJson(text), JSON.parse(text))
  }
})

test('duplicate keys are last-wins like JSON.parse', () => {
  assert.deepEqual(parseImportJson('{"k":1,"k":2}'), { k: '2' })
})

test('__proto__ becomes an own property, not a prototype swap', () => {
  const parsed = parseImportJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>
  assert.deepEqual(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value, { polluted: true })
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
})

test('top-level scalars parse like JSON.parse (numbers as their text)', () => {
  assert.equal(parseImportJson('42'), '42')
  assert.equal(parseImportJson('-7'), '-7')
  assert.equal(parseImportJson('"text"'), 'text')
  assert.equal(parseImportJson('true'), true)
  assert.equal(parseImportJson('null'), null)
})

test('malformed documents throw SyntaxError with a position', () => {
  for (const text of [
    '',
    '   ',
    '{',
    '{"a"}',
    '{"a":}',
    '{"a":1,}',
    '[1,]',
    "{'a':1}",
    '01',
    '+1',
    '.5',
    '1.',
    '--1',
    '1e',
    '1e+',
    '[123abc]',
    'tru',
    'NaN',
    '"unterminated',
    '"bad\\xescape"',
    '{} trailing',
    '{"a":1}{"b":2}',
  ]) {
    const err = syntaxError(text)
    assert.match(err.message, /at position \d+/)
  }
})

test('unescaped control characters in strings are rejected', () => {
  syntaxError('"a\u0000b"')
  syntaxError('"a\nb"')
})

test('nesting at the cap parses; beyond it is rejected instead of crashing', () => {
  let node: unknown = parseImportJson('['.repeat(200) + '7' + ']'.repeat(200))
  let depth = 0
  while (Array.isArray(node)) {
    node = node[0]
    depth++
  }
  assert.equal(depth, 200)
  assert.equal(node, '7')

  const err = syntaxError('['.repeat(201) + ']'.repeat(201))
  assert.match(err.message, /nesting deeper than 200/)
})
