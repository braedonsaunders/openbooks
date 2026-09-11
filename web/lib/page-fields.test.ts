import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundPaths, describeFields } from './page-fields'

const paths = (data: unknown) => describeFields(data).fields.map((field) => field.path)
const find = (data: unknown, path: string) =>
  describeFields(data).fields.find((field) => field.path === path)

test('leaves are listed with their type and a sample', () => {
  const field = find({ title: 'Invoices', count: 12, open: true }, 'title')
  assert.deepEqual(field, { path: 'title', type: 'string', sample: 'Invoices' })
  assert.equal(find({ count: 12 }, 'count')?.type, 'number')
  assert.equal(find({ open: true }, 'open')?.sample, 'true')
})

test('nested objects contribute both the container and its leaves', () => {
  // `repeat` and `table` bind containers, so dropping them would hide half the
  // vocabulary; listing only containers would hide the other half.
  assert.deepEqual(paths({ summary: { total: '1.00' } }), ['summary', 'summary.total'])
})

test('an array reports its length and the shape of a ROW, not indexed paths', () => {
  // `lines.0.amount` is a path no table can use: columns resolve against the
  // row, so reporting the indexed form would teach an author the wrong thing.
  const field = find({ lines: [{ amount: '1.00', memo: 'a' }] }, 'lines')
  assert.equal(field?.type, 'array')
  assert.equal(field?.count, 1)
  assert.deepEqual(field?.item?.map((f) => f.path), ['amount', 'memo'])
  assert.ok(!paths({ lines: [{ amount: '1.00' }] }).some((p) => /\d/.test(p)))
})

test('a row shape merges across items so an optional field is still reported', () => {
  const field = find({ rows: [{ id: '1' }, { id: '2', drill: { to: 'x' } }] }, 'rows')
  assert.deepEqual(field?.item?.map((f) => f.path), ['drill', 'drill.to', 'id'])
})

test('a field that is null in the first row keeps the informative type', () => {
  const field = find({ rows: [{ memo: null }, { memo: 'seen' }] }, 'rows')
  assert.equal(field?.item?.[0]?.type, 'string')
})

test('a React element is called a node rather than an object', () => {
  // Reported as `object`, an author would try to bind `header.props.children`
  // and get a path that resolves to something no block can render.
  const element = { $$typeof: Symbol.for('react.element'), props: { children: 'x' } }
  const field = find({ header: element }, 'header')
  assert.equal(field?.type, 'node')
  assert.ok(!paths({ header: element }).includes('header.props'))
})

test('a function is reported as unbindable, not omitted', () => {
  // Omitted, an author sees a gap and wonders what they are missing. Named,
  // they know the answer is "nothing you can use".
  assert.equal(find({ onSave: () => {} }, 'onSave')?.type, 'unbindable')
})

test('a key that cannot be written as a dot path is not offered', () => {
  assert.deepEqual(paths({ 'has space': 1, 'ok': 2 }), ['ok'])
})

test('the walk is bounded and says so', () => {
  const deep: Record<string, unknown> = {}
  let node = deep
  for (let i = 0; i < 20; i++) {
    const child: Record<string, unknown> = {}
    node.child = child
    node = child
  }
  node.leaf = 'bottom'
  const catalog = describeFields(deep)
  assert.ok(catalog.fields.some((field) => field.truncated))
  assert.ok(!catalog.fields.some((field) => field.path.split('.').length > 5))
})

test('a self-referential structure terminates', () => {
  // Loader output is plain data by convention, not by enforcement. A cycle
  // must cost a bounded walk rather than a hung request.
  const item: Record<string, unknown> = { name: 'a' }
  item.siblings = [item]
  assert.ok(describeFields({ items: [item] }).fields.length < 100)
})

test('samples are truncated so one long string cannot dominate the answer', () => {
  const sample = find({ blob: 'x'.repeat(500) }, 'blob')?.sample ?? ''
  assert.ok(sample.length < 140, `sample was ${sample.length} chars`)
  assert.ok(sample.endsWith('…'))
})

test('boundPaths finds every field reference at any depth', () => {
  const spec = {
    header: [{ kind: 'page-header', title: { $: 'title' } }],
    body: [
      { kind: 'table', rows: { $: 'lines' }, columns: [{ header: 'A', cell: { kind: 'text', field: { $: 'memo' } } }] },
      { kind: 'grid', blocks: [{ kind: 'text', content: { $: 'note' }, when: { $: 'hasNote' } }] },
    ],
  }
  assert.deepEqual(boundPaths(spec), ['hasNote', 'lines', 'memo', 'note', 'title'])
})

test('boundPaths ignores an object that merely has a $ among other keys', () => {
  // A field ref is `{ $: path }` and nothing else. Treating `{ $: 'x', y: 1 }`
  // as one would report a binding the renderer does not make.
  assert.deepEqual(boundPaths({ a: { $: 'real' }, b: { $: 'fake', extra: 1 } }), ['real'])
})
