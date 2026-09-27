import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditSource, reconcile } from './check-bypass-justification.mjs'

// The gate fails silently in the dangerous direction if it stops seeing a
// bypass call or starts accepting a tag it should refuse, so each test pins
// one edge of what counts as a justified call.

const audit = (body) => auditSource('engine/src/example/work.ts', `import { withBypass, withBypassContext } from '../platform/db.ts'\n${body}`)

test('a known reason with a sentence, within three lines, justifies the call', () => {
  const { tagged, untagged, failures } = audit([
    'export async function scan() {',
    '  // bypass: scheduler-tick — due rows are found across every organization.',
    '  // The claim below re-enters each row\'s own scope.',
    '  const due = await withBypassContext(() =>',
    '    load())',
    '}',
  ].join('\n'))
  assert.deepEqual(tagged, [{ path: 'engine/src/example/work.ts', line: 5, fn: 'scan', reason: 'scheduler-tick' }])
  assert.deepEqual([untagged, failures], [[], []])
})

test('a tag four lines up, a comment mention, or a string mention does not justify or count', () => {
  const { tagged, untagged, failures } = audit([
    'export async function far() {',
    '  // bypass: scheduler-tick — too far above the call to belong to it.',
    '  const a = 1',
    '  const b = 2',
    '  const c = 3',
    '  return withBypass(async () => a + b + c)',
    '}',
    '// withBypass(() => prose) in a comment is not a call',
    '// bypass: true })) is prose naming a resolver flag, not a tag',
    "const help = 'wrap it in withBypassContext(() => ...)'",
  ].join('\n'))
  assert.deepEqual(tagged, [])
  assert.deepEqual(untagged, [{ path: 'engine/src/example/work.ts', line: 7, fn: 'far' }])
  assert.deepEqual(failures.map((f) => [f.line, f.message]), [
    [3, 'bypass tag has no withBypass/withBypassContext call within 3 lines below it'],
  ])
})

test('an unknown reason or a bare reason is refused by name at the call', () => {
  const { tagged, failures } = audit([
    '// bypass: convenience — it was easier.',
    'await withBypass(async () => 1)',
    '// bypass: scheduler-tick',
    'await withBypassContext(async () => 2)',
  ].join('\n'))
  assert.deepEqual(tagged, [])
  assert.deepEqual(failures.map((f) => [f.line, f.message]), [
    [3, 'unknown bypass reason "convenience"'],
    [5, 'bypass reason "scheduler-tick" says nothing about this site'],
  ])
})

test('a renamed import is still a bypass call, and passing the helper around uncalled fails', () => {
  const { untagged, failures } = auditSource('web/lib/example.ts', [
    "import { withBypass as trusted, withBypassContext } from './db'",
    'export const run = () => trusted(async () => 1)',
    'export const scope = { wrap: withBypassContext }',
  ].join('\n'))
  assert.deepEqual(untagged, [{ path: 'web/lib/example.ts', line: 2, fn: 'run' }])
  assert.deepEqual(failures.map((f) => [f.line, f.message]), [
    [3, 'withBypassContext is used without being called; call it where the bypass is justified'],
  ])
})

test('the allowlist ratchet fails an unlisted call, a grown count, and a shrunk or vanished entry', () => {
  const site = (fn, line) => ({ path: 'engine/src/a.ts', line, fn })
  const entry = (fn, calls) => ({ path: 'engine/src/a.ts', fn, calls, finding: 'organization already known' })
  const { unlisted, miscounted } = reconcile(
    [site('listed', 1), site('grown', 2), site('grown', 3), site('shrunk', 4), site('stray', 5)],
    [entry('listed', 1), entry('grown', 1), entry('shrunk', 2), entry('gone', 1)],
  )
  assert.deepEqual(unlisted, [site('stray', 5)])
  assert.deepEqual(miscounted.map((e) => [e.fn, e.calls, e.found]), [['grown', 1, 2], ['shrunk', 2, 1], ['gone', 1, 0]])
})
