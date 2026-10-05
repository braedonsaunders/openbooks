import assert from 'node:assert/strict'
import test from 'node:test'
import { RegisteredListTable } from './registered-list-table'
import { PreparedPagedTable } from './prepared-paged-table'
import { ServerPagedTable } from './server-paged-table'

test('server windows retain rows and source totals without client slicing', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: String(index),
    name: `Record ${index}`,
  }))
  const result = RegisteredListTable({
    source: 'admin_api_keys',
    rows,
    rowKey: (row) => row.id,
    empty: 'Empty',
    state: { total: 250, page: 3, perPage: 25 },
    columns: [{ key: 'name', header: 'Name', cell: (row) => row.name }],
  })
  assert.equal(result.type, ServerPagedTable)
  assert.equal(result.props.rows, rows)
  assert.equal(result.props.total, 250)
  assert.equal(result.props.page, 3)
  assert.equal(result.props.perPage, 25)
})

test('loaded lists pass only rendered cells and declared search text across the client boundary', () => {
  const result = RegisteredListTable({
    source: 'hrm_compensation_cycles',
    rows: [{ id: 'record', name: 'Displayed', internal: 'Undisplayed' }],
    rowKey: (row) => row.id,
    empty: 'Empty',
    columns: [
      {
        key: 'name',
        header: 'Name',
        cell: (row) => row.name,
        search: (row) => row.name,
      },
    ],
  })
  assert.equal(result.type, PreparedPagedTable)
  assert.deepEqual(result.props.rows[0].cells, ['Displayed'])
  assert.equal(result.props.rows[0].searchText, 'Displayed')
  assert.equal('internal' in result.props.rows[0], false)
  assert.equal('cell' in result.props.columns[0], false)
})

test('rows without unique identities and server lists without counts refuse', () => {
  const props = {
    source: 'data_import_history' as const,
    empty: 'Empty',
    columns: [],
    rowKey: (row: { id: string }) => row.id,
  }
  assert.throws(
    () => RegisteredListTable({ ...props, rows: [{ id: '' }] }),
    /unique stable identities: data_import_history/,
  )
  assert.throws(
    () =>
      RegisteredListTable({
        ...props,
        rows: [{ id: 'duplicate' }, { id: 'duplicate' }],
      }),
    /unique stable identities/,
  )
  assert.throws(
    () => RegisteredListTable({ ...props, source: 'admin_api_keys', rows: [] }),
    /Missing server pagination.*admin_api_keys/,
  )
})

test('loaded list filters remain beside search when the collection is empty', async () => {
  const React = await import('react')
  Object.assign(globalThis, { React })
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { NextIntlClientProvider } = await import('next-intl')
  const messages = (await import('../messages/en')).default
  for (const rows of [[], [{ id: 'one', name: 'Employee' }]]) {
    const result = RegisteredListTable({
      source: 'hrm_change_requests',
      rows,
      rowKey: (row) => row.id,
      columns: [
        {
          key: 'name',
          header: 'Employee',
          cell: (row) => row.name,
          search: (row) => row.name,
        },
      ],
      empty: 'No change requests',
      toolbarAfter: <button>Status filter</button>,
    })
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
        {result}
      </NextIntlClientProvider>,
    )
    assert.equal(
      (html.match(/<input/g) ?? []).length,
      1,
      'the list has exactly one search field',
    )
    assert.equal(
      (html.match(/Status filter/g) ?? []).length,
      1,
      'empty lists retain the status controls',
    )
    assert.ok(
      html.indexOf('Status filter') < html.indexOf('<table'),
      'filters stay on the shared search toolbar above the table',
    )
  }
})


test('server controls share the universal toolbar and fixed readers omit ineffective page-size controls', () => {
  const toolbar = <button>Status</button>
  const result = RegisteredListTable({
    source: 'hrm_org_chart_directory',
    rows: [], rowKey: (row: { id: string }) => row.id,
    empty: 'No employees', columns: [],
    state: { total: 0, page: 1, perPage: 50 },
    toolbarAfter: toolbar,
  })
  assert.equal(result.type, ServerPagedTable)
  assert.equal(result.props.toolbar, toolbar, 'domain controls belong to the shared table toolbar')
  assert.equal(result.props.showPerPage, false, 'fixed readers cannot honor another page size')
})
