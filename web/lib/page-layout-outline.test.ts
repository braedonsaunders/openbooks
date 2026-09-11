import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PageSpec } from '@braedonsaunders/appkit-viewspec'
import { countBlocks, moveBlock, outlineSpec, removeBlock } from './page-layout-outline'

const spec = (): PageSpec => ({
  specVersion: 1,
  route: '/demo',
  layout: 'list',
  header: [{ kind: 'page-header', title: { $: 'title' }, actions: [{ widget: 'a' }, { widget: 'b' }] }],
  body: [
    {
      kind: 'grid',
      className: 'grid',
      blocks: [
        { kind: 'stat-tile', iconKey: 'x', accent: 'indigo', label: 'Cash', value: { $: 'cash' } },
        { kind: 'widget', widget: 'trend-chart', when: { $: 'hasTrend' } },
      ],
    },
    {
      kind: 'table',
      rows: { $: 'lines' },
      rowKey: { $: 'id' },
      columns: [
        { header: 'A', cell: { kind: 'text', field: { $: 'a' } } },
        { header: 'B', cell: { kind: 'text', field: { $: 'b' } } },
      ],
    },
  ],
})

test('the outline names each block and keeps a path back to it', () => {
  const outline = outlineSpec(spec())
  assert.deepEqual(outline.header[0]!.path, ['header', 0])
  assert.equal(outline.header[0]!.kind, 'page-header')
  // A bound title is reported as a binding, not as literal text — the editor
  // shows the field path rather than pretending the page says "title".
  assert.equal(outline.header[0]!.name, 'title')
  assert.equal(outline.header[0]!.nameIsBinding, true)
  assert.equal(outline.header[0]!.count, 2, 'header actions are counted')

  const [grid, table] = outline.body
  assert.deepEqual(grid!.path, ['body', 0])
  assert.equal(grid!.count, 2)
  assert.deepEqual(grid!.children.map((c) => c.path), [['body', 0, 'blocks', 0], ['body', 0, 'blocks', 1]])
  assert.deepEqual(table!.path, ['body', 1])
  assert.equal(table!.name, 'lines')
  assert.equal(table!.count, 2, 'a table counts its columns')
})

test('a literal name is distinguished from a bound one', () => {
  const tile = outlineSpec(spec()).body[0]!.children[0]!
  assert.equal(tile.name, 'Cash')
  assert.equal(tile.nameIsBinding, false)
})

test('a widget is named by its widget, which a spec can never compute', () => {
  const widget = outlineSpec(spec()).body[0]!.children[1]!
  assert.equal(widget.name, 'trend-chart')
  assert.equal(widget.nameIsBinding, false)
})

test('a block carrying `when` is flagged as conditional', () => {
  // The reader needs to know the page may already omit this block for some
  // people, or they will hide something that was never showing.
  const children = outlineSpec(spec()).body[0]!.children
  assert.equal(children[0]!.conditional, false)
  assert.equal(children[1]!.conditional, true)
})

test('removing a block drops exactly that one and leaves the source untouched', () => {
  const original = spec()
  const next = removeBlock(original, ['body', 0, 'blocks', 0])
  assert.equal(original.body[0]!.kind === 'grid' && original.body[0].blocks.length, 2, 'the input is not mutated')
  const grid = next.body[0]!
  assert.ok(grid.kind === 'grid')
  assert.deepEqual(grid.blocks.map((b) => b.kind), ['widget'])
})

test('a path that misses returns the ORIGINAL object, so a no-op is detectable', () => {
  // The editor pushes an undo entry only when something changed; comparing by
  // identity is how it knows.
  const original = spec()
  assert.equal(removeBlock(original, ['body', 99]), original)
  assert.equal(moveBlock(original, ['body', 0], -1), original, 'moving the first block up is a no-op')
  assert.equal(moveBlock(original, ['body', 1], 1), original, 'moving the last block down is a no-op')
  assert.equal(removeBlock(original, ['body']), original, 'a path with no index cannot address a block')
})

test('moving swaps a block with its neighbour and nothing else', () => {
  const next = moveBlock(spec(), ['body', 1], -1)
  assert.deepEqual(next.body.map((b) => b.kind), ['table', 'grid'])
  const back = moveBlock(next, ['body', 0], 1)
  assert.deepEqual(back.body.map((b) => b.kind), ['grid', 'table'])
})

test('structural edits always leave a spec the schema still accepts', async () => {
  // This is the whole reason the structure editor needs no validation step:
  // removing and reordering existing blocks cannot produce a document the
  // renderer would refuse.
  const { validateSpec } = await import('@braedonsaunders/appkit-viewspec')
  const edited = moveBlock(removeBlock(spec(), ['body', 0, 'blocks', 1]), ['body', 1], -1)
  assert.equal(validateSpec(edited).ok, true)
})

test('countBlocks counts every depth', () => {
  assert.equal(countBlocks(outlineSpec(spec())), 5)
})
