import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAgainstRegistries } from './page-spec-validate'
import { specShapes } from './page-spec-shapes'

const registries = { widgets: new Set(['link-button']), frames: new Set<string>() }
const errorsFor = (body: unknown[], header: unknown[] = []) => {
  const result = validateAgainstRegistries({ specVersion: 1, layout: 'detail', header, body }, registries)
  assert.equal(result.ok, false)
  return result.ok ? [] : result.errors
}

test('a union failure names the property inside the block the author meant', () => {
  assert.deepEqual(errorsFor([{ kind: 'stat-tile', label: 'Open', value: '3' }]), [
    'body.0.iconKey: is required',
    'body.0.accent: is required',
  ])
  assert.deepEqual(errorsFor([], [{ kind: 'page-header', title: 'Clients', subtitle: 'x' }]), ['header.0: Unrecognized key: "subtitle"'])
  assert.deepEqual(errorsFor([{ kind: 'grid', blocks: [{ kind: 'heading', content: 'x', level: 4 }] }]), ['body.0.blocks.0.level: use one of 2, 3'])
  assert.deepEqual(errorsFor([{ kind: 'table', rows: { $: 'rows' }, rowKey: { $: 'id' }, columns: [{ header: 'A', cell: { kind: 'text' } }] }]), [
    'body.0.columns.0.cell.field: is required',
  ])
})

test('an unknown kind lists the kinds that exist', () => {
  const [error] = errorsFor([{ kind: 'kpi-row' }])
  assert.match(error!, /^body\.0: unknown kind; use one of "page-header", .*"stat-tile"/)
})

test('every block and cell kind publishes its required and optional properties', () => {
  const { blocks, cells } = specShapes()
  assert.deepEqual(blocks['stat-tile']!.required, {
    kind: '"stat-tile"', iconKey: 'string | FieldRef', accent: 'string | FieldRef', label: 'string | FieldRef', value: 'string | FieldRef',
  })
  assert.equal(blocks.heading!.required.level, '2 | 3')
  assert.equal(blocks.grid!.required.blocks, 'Block[]')
  assert.equal(cells.drill!.required.inner, 'Cell')
  assert.ok(['page-header', 'table', 'panel', 'repeat', 'widget', 'frame'].every((kind) => kind in blocks))
})

test('a field reference nested inside a widget prop is refused, a whole-prop reference is not', () => {
  const nested = validateAgainstRegistries({
    specVersion: 1, layout: 'list', header: [],
    body: [{ kind: 'widget', widget: 'link-button', props: { href: { $: 'href' }, label: { text: { $: 'label' } } } }],
  }, registries)
  assert.equal(nested.ok, false)
  assert.deepEqual(nested.ok ? [] : nested.errors, ['widget "link-button" prop "label" nests a field reference; a reference binds only as a whole prop value ("label": { "$": "path" })'])
})
