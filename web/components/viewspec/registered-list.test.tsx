import assert from 'node:assert/strict'
import test from 'node:test'
import { column, field, text, table } from '@braedonsaunders/appkit-viewspec'
import { RegisteredListBlockView, listCellSearchText } from './registered-list'

test('displayed search values exclude internal fields and navigation targets', () => {
  const scope = {
    name: 'Displayed',
    secret: 'Hidden',
    href: '/internal/record',
  }
  assert.equal(
    listCellSearchText(text(field('name')), scope).trim(),
    'Displayed',
  )
  assert.ok(!listCellSearchText(text(field('name')), scope).includes('Hidden'))
})

test('a saved layout cannot substitute another collection for its registered source', () => {
  const spec = table({
    variant: 'app',
    rows: field('otherRows'),
    rowKey: field('id'),
    columns: [column('Name', text(field('name')))],
  })
  assert.throws(
    () =>
      RegisteredListBlockView({
        source: 'data_import_history',
        spec,
        scope: { otherRows: [] },
        searchParams: {},
      }),
    /collection does not match.*data_import_history/,
  )
})

test('row cells retain the page scope at nested depths', () => {
  const spec = table({
    variant: 'app',
    rows: field('rows'),
    rowKey: field('id'),
    columns: [column(field('heading'), text(field('name')))],
  })
  const result = RegisteredListBlockView({
    source: 'data_import_history',
    spec,
    scope: { heading: 'Record', rows: [{ id: 'one', name: 'First' }] },
    searchParams: {},
  })
  assert.equal(result.props.columns[0].header, 'Record')
  assert.equal(result.props.rowKey(result.props.rows[0], 0), 'one')
  assert.equal(
    result.props.columns[0].search(result.props.rows[0]).trim(),
    'First',
  )
})

test('record identity comes from the source even when a saved layout supplies another key', () => {
  const spec = table({
    variant: 'app',
    rows: field('rows'),
    rowKey: field('name'),
    columns: [column('Name', text(field('name')))],
  })
  const result = RegisteredListBlockView({
    source: 'data_import_history',
    spec,
    scope: { rows: [{ id: 'stable-id', name: 'Mutable display name' }] },
    searchParams: {},
  })
  assert.equal(result.props.rowKey(result.props.rows[0], 0), 'stable-id')
})

test('registered widget composition renders typed cells through the shared table', async () => {
  const React = await import('react')
  Object.assign(globalThis, { React })
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { NextIntlClientProvider } = await import('next-intl')
  const messages = (await import('../../messages/en')).default
  const { BlockView } = await import('./blocks')
  const { registeredListTable } = await import('../../lib/list/prepared-spec')
  const block = registeredListTable('admin_api_keys', {
    variant: 'app',
    rows: field('rows'),
    rowKey: field('id'),
    columns: [column(field('heading'), text(field('name')))],
  })
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: `key-${index}`,
    name: `Visible key ${index}`,
  }))
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <BlockView
        block={block}
        scope={{
          heading: 'API key',
          rows,
          total: 250,
          currentPage: 3,
          perPage: 25,
        }}
        searchParams={{ q: 'key' }}
      />
    </NextIntlClientProvider>,
  )
  assert.ok(html.includes('API key'))
  for (const row of rows) assert.ok(html.includes(row.name), row.id)
  assert.equal((html.match(/<tbody/g) ?? []).length, 1)
  assert.equal(
    (html.match(/<td/g) ?? []).length,
    25,
    'the shared renderer must not slice the server window',
  )
})
