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
    scope: { heading: 'Record', rows: [{ id: 'one', name: 'First' }], total: 1, currentPage: 1, perPage: 25 },
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
    scope: { rows: [{ id: 'stable-id', name: 'Mutable display name' }], total: 1, currentPage: 1, perPage: 25 },
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


test('coverage windows retain the domain pager and every worker returned by its reader', async () => {
  const React = await import('react')
  Object.assign(globalThis, { React })
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { NextIntlClientProvider } = await import('next-intl')
  const messages = (await import('../../messages/en')).default
  const { BlockView } = await import('./blocks')
  const { registeredListTable } = await import('../../lib/list/prepared-spec')
  const rows = Array.from({ length: 50 }, (_, index) => ({
    employmentId: `worker-${index}`, workerName: `Worker ${index}`,
  }))
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <BlockView
        block={registeredListTable('hrm_qualifications_coverage', {
          variant: 'app', rows: field('coverageRows'), rowKey: field('employmentId'),
          columns: [column('Worker', text(field('workerName')))],
        })}
        scope={{ coverageRows: rows, coverageTotal: 125, coveragePage: 2, coveragePerPage: 50 }}
        searchParams={{ crewPage: '2' }}
      />
    </NextIntlClientProvider>,
  )
  assert.equal((html.match(/<td/g) ?? []).length, 50, 'a 50-worker server page must not be sliced to ten workers')
  for (const row of rows) assert.ok(html.includes(row.workerName), row.employmentId)
  assert.ok(!html.includes('<input'), 'a client search cannot cover the remaining server pages')
  assert.ok(!html.includes('<select'), 'the fixed-size crew reader cannot honor another page size')
  assert.ok(!html.includes('Page 1'), 'the spec-owned crew pager must not gain a second pager')
})
