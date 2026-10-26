import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindLiteralProps, boundPaths, describeFields, unresolvedPaths } from './page-fields'

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

test('unresolved paths are reported in the scope the renderer resolves them in', () => {
  const data = { title: 'Projects', summary: { total: '12.00' }, rows: [{ id: 'a', name: 'Riverside', amount: '1.00' }], empty: [] as unknown[] }
  const spec = {
    header: [{ kind: 'page-header', title: { $: 'titel' } }],
    body: [
      { kind: 'text', content: { $: 'summary.total' } },
      {
        kind: 'table', rows: { $: 'rows' }, rowKey: { $: 'id' },
        columns: [
          { header: { $: 'title' }, cell: { kind: 'text', field: { $: 'nme' } } },
          { header: 'Total', cell: { kind: 'money', field: { $: '$root.summary.total' } } },
          { header: 'Amount', cell: { kind: 'money', field: { $: 'amount' } } },
        ],
      },
      // No rows this run: nothing can be said about the row shape.
      { kind: 'repeat', items: { $: 'empty' }, itemKey: { $: 'id' }, blocks: [{ kind: 'text', content: { $: 'anything' } }] },
    ],
  }
  assert.deepEqual(unresolvedPaths(spec, describeFields(data)), [
    { path: 'titel', scope: 'page', suggestion: 'title' },
    { path: 'nme', scope: 'row', suggestion: 'name' },
  ])
})

test('a path under a value the catalog could not open is not claimed missing', () => {
  const data = { detail: null, summary: { total: '1.00' } }
  assert.deepEqual(unresolvedPaths({ body: [{ kind: 'text', content: { $: 'detail.note' } }] }, describeFields(data)), [])
  assert.equal(unresolvedPaths({ body: [{ kind: 'text', content: { $: 'summary.count' } }] }, describeFields(data)).length, 1)
})

test('built-in widget props are bound back to the loader paths they came from', () => {
  const rows: unknown[] = []
  const data = { title: 'Customers', directory: [{ href: '/customers', label: 'Customers' }], arOutstanding: 'CA$0', arOverdue: 'CA$0', total: 'CA$0', perPage: 25, topExposure: rows, other: [] }
  const builtIn = {
    header: [{ kind: 'page-header', title: { $: 'title' }, actions: [{ widget: 'module-home-tabs', props: { tabs: [] } }] }],
    body: [
      { kind: 'widget', widget: 'directory-section', props: { items: [{ href: '/customers', label: 'Customers' }], title: 'Customers' } },
      // CA$0 appears at three paths: the prop name picks one; with no named path it stays literal.
      { kind: 'widget', widget: 'customer-ar-pulse', props: { outstanding: 'CA$0', amount: 'CA$0', size: 25 } },
      // The same (empty) list instance the loader produced binds by identity.
      { kind: 'widget', widget: 'relationships-section', props: { rows, fallback: [] } },
      { kind: 'table', rows: { $: 'directory' }, rowKey: { $: 'href' }, columns: [{ header: 'Link', cell: { kind: 'widget', widget: 'link-cell', props: { label: 'Customers' } } }] },
    ],
  }
  const bound = bindLiteralProps(builtIn, data) as typeof builtIn
  assert.deepEqual(bound.body[0]!.props, { items: { $: 'directory' }, title: { $: 'title' } })
  assert.deepEqual(bound.body[1]!.props, { outstanding: { $: 'arOutstanding' }, amount: 'CA$0', size: { $: 'perPage' } })
  assert.deepEqual(bound.body[2]!.props, { rows: { $: 'topExposure' }, fallback: [] })
  assert.deepEqual(bound.header[0]!.actions![0]!.props, { tabs: [] })
  // A cell resolves against its row, so its literal props are untouched.
  assert.deepEqual((bound.body[3] as { columns: { cell: { props: unknown } }[] }).columns[0]!.cell.props, { label: 'Customers' })
})
