import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

/**
 * The reporter's turn route is reachable by every signed-in person, so its
 * boundary is the interesting thing to pin: what it accepts, what it refuses,
 * and what it hands the package's interpreter.
 */

// The shared zod atoms live behind `server-only` for the bundler's benefit.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { feedbackToolPartsFromResult, feedbackTurnBody } = await import('./turn')

test('a report is accepted with its page context and defaults', () => {
  const parsed = feedbackTurnBody.safeParse({
    text: '  the invoice total is wrong  ',
    context: { pathname: '/ar/invoices', pageTitle: 'Invoices' },
  })
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal(parsed.data.text, 'the invoice total is wrong')
  assert.equal(parsed.data.pathname, '/ar/invoices')
  assert.equal(parsed.data.pageTitle, 'Invoices')
  assert.equal(parsed.data.includePage, true, 'page context is opt-out, not opt-in')
  assert.equal(parsed.data.forceFile, false)
  assert.equal(parsed.data.sessionId, null)
  assert.deepEqual(parsed.data.answers, {})
})

test('a report with no page context still parses, defaulting the path', () => {
  const parsed = feedbackTurnBody.safeParse({ text: 'something broke' })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.pathname, '/')
})

test('an empty or missing report is refused rather than filed', () => {
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 42 }, { text: null }]) {
    assert.equal(
      feedbackTurnBody.safeParse(body).success,
      false,
      `${JSON.stringify(body)} must not parse`,
    )
  }
})

test('an oversized report is refused, not truncated', () => {
  assert.equal(feedbackTurnBody.safeParse({ text: 'x'.repeat(4_001) }).success, false)
  assert.equal(feedbackTurnBody.safeParse({ text: 'x'.repeat(4_000) }).success, true)
})

test('a session id that is not a uuid is refused', () => {
  assert.equal(feedbackTurnBody.safeParse({ text: 'hi', sessionId: 'abc' }).success, false)
  assert.equal(feedbackTurnBody.safeParse({ text: 'hi', sessionId: randomUUID() }).success, true)
  assert.equal(feedbackTurnBody.safeParse({ text: 'hi', sessionId: null }).success, true)
})

test('answers keep only non-empty strings, trimmed and bounded', () => {
  const parsed = feedbackTurnBody.safeParse({
    text: 'hi',
    answers: { q1: '  yes ', q2: '   ', q3: 7, q4: null, q5: 'x'.repeat(2_000) },
  })
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal(parsed.data.answers.q1, 'yes')
  assert.ok(!('q2' in parsed.data.answers))
  assert.ok(!('q3' in parsed.data.answers))
  assert.equal(parsed.data.answers.q5?.length, 1_000, 'one answer cannot carry a whole document')
})

test('an answers object that is large by construction is refused, not buffered', () => {
  const tooMany: Record<string, string> = {}
  for (let i = 0; i < 9; i += 1) tooMany[`q${i}`] = 'yes'
  const keys = feedbackTurnBody.safeParse({ text: 'hi', answers: tooMany })
  assert.equal(keys.success, false)
  if (!keys.success) {
    assert.ok(
      keys.error.issues.some((issue) => issue.message.includes('at most 8 answers')),
      `refusal must name the key limit, got: ${JSON.stringify(keys.error.issues)}`,
    )
  }

  const longKey = feedbackTurnBody.safeParse({ text: 'hi', answers: { ['k'.repeat(129)]: 'yes' } })
  assert.equal(longKey.success, false)

  const bigValue = feedbackTurnBody.safeParse({
    text: 'hi',
    answers: { q1: 'x'.repeat(4_001) },
  })
  assert.equal(bigValue.success, false)
  if (!bigValue.success) {
    assert.ok(
      bigValue.error.issues.some((issue) => issue.message.includes('at most 4000 characters')),
      `refusal must name the value limit, got: ${JSON.stringify(bigValue.error.issues)}`,
    )
  }
})

test('answers at the raw ceilings still parse, then trim to the kept bounds', () => {
  const atCeiling: Record<string, string> = {}
  for (let i = 0; i < 8; i += 1) atCeiling[`q${i}`] = 'x'.repeat(4_000)
  const parsed = feedbackTurnBody.safeParse({ text: 'hi', answers: atCeiling })
  assert.equal(parsed.success, true)
  if (!parsed.success) return
  assert.equal(Object.keys(parsed.data.answers).length, 8)
  assert.ok(Object.values(parsed.data.answers).every((answer) => answer.length === 1_000))
})

test('page context is dropped when the reporter removes it', () => {
  const parsed = feedbackTurnBody.safeParse({
    text: 'hi',
    context: { pathname: '/ar/invoices' },
    includePage: false,
  })
  assert.equal(parsed.success, true)
  if (parsed.success) assert.equal(parsed.data.includePage, false)
})

test('an unbounded pathname or page title is refused', () => {
  assert.equal(
    feedbackTurnBody.safeParse({ text: 'hi', context: { pathname: '/'.repeat(4_000) } }).success,
    false,
  )
  assert.equal(
    feedbackTurnBody.safeParse({ text: 'hi', context: { pageTitle: 'x'.repeat(500) } }).success,
    false,
  )
})

test('tool calls are collected from both shapes a provider may use', () => {
  const parts = feedbackToolPartsFromResult({
    steps: [
      { toolResults: [{ toolName: 'search_help', output: { hits: [] } }] },
      { content: [{ type: 'tool-result', toolName: 'submit_issue', output: { number: 7 } }] },
      { content: [{ type: 'text' }] },
    ],
  })
  assert.deepEqual(
    parts.map((part) => part.toolName),
    ['search_help', 'submit_issue'],
  )
  assert.ok(parts.every((part) => part.state === 'output-available'))
})
