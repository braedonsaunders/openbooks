import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../messages/en'
import { PagedTable } from './paged-table'
import { PreparedPagedRows } from './paged-table-client'

// Component modules render JSX with the automatic runtime; expose React for them.
Object.assign(globalThis, { React })

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  )

const bodyRows = (html: string) => (html.split('<tbody')[1]?.match(/<tr\b/g) ?? []).length

test('server windows retain rows and source totals without client slicing', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: String(index),
    name: `Record ${index}`,
  }))
  const html = render(
    <PagedTable
      prepared
      source="admin_api_keys"
      rows={rows}
      rowKey={(row) => row.id}
      empty="Empty"
      serverWindow={{ total: 250, page: 3, perPage: 25 }}
      columns={[{ key: 'name', header: 'Name', cell: (row) => row.name }]}
    />,
  )
  assert.equal(bodyRows(html), 25, 'every row of the window renders')
  assert.ok(html.includes('Record 24'))
  assert.match(html, /51[^<]*<\/strong>[\s\S]*75[\s\S]*250/, 'the pager shows the window inside the source total')
  assert.match(html, /href="\/admin\/api-keys\?page=4"/, 'the pager links to the next server page')
})

test('inventory counts use the shared server pager on the host route', () => {
  const html = render(
    <PagedTable
      prepared
      source="inventory_counts"
      rows={[{ id: 'count-1', date: '2026-10-18' }]}
      rowKey={(row) => row.id}
      empty="Empty"
      serverWindow={{ total: 620, page: 4, perPage: 25 }}
      basePath="/inventory"
      currentParams={{ inventoryView: 'counts', page: '4' }}
      columns={[{ key: 'date', header: 'Date', cell: (row) => row.date }]}
    />,
  )
  assert.equal(bodyRows(html), 1)
  assert.match(html, /href="\/inventory\?inventoryView=counts&amp;page=5"/, 'paging keeps the host view')
  assert.match(html, /perPage=50/, 'the page-size selector links on the host route')
})

test('loaded lists pass only rendered cells and declared search text across the client boundary', () => {
  const result = PagedTable({
    prepared: true,
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
  }) as React.ReactElement<React.ComponentProps<typeof PreparedPagedRows>>
  assert.equal(result.type, PreparedPagedRows)
  const [row] = result.props.rows
  assert.ok(row)
  assert.deepEqual(row.cells, ['Displayed'])
  assert.equal(row.searchText, 'Displayed')
  assert.equal('internal' in row, false)
  assert.equal('cell' in (result.props.columns[0] ?? {}), false)
  assert.equal('search' in (result.props.columns[0] ?? {}), false)
})

test('a loaded list follows the URL sort through exact decimal values', () => {
  const result = PagedTable({
    prepared: true,
    source: 'hrm_compensation_bands',
    rows: [
      { id: 'a', amount: '10.50' },
      { id: 'b', amount: '9.75' },
      { id: 'c', amount: null },
      { id: 'd', amount: '100.00' },
    ],
    rowKey: (row) => row.id,
    empty: 'Empty',
    sort: 'amount',
    dir: 'desc',
    columns: [
      {
        key: 'amount',
        header: 'Amount',
        sortKey: 'amount',
        sortType: 'decimal',
        sortValue: (row) => row.amount,
        cell: (row) => row.amount ?? '—',
      },
    ],
  }) as React.ReactElement<React.ComponentProps<typeof PreparedPagedRows>>
  assert.deepEqual(result.props.rows.map((row) => row.id), ['d', 'a', 'b', 'c'], 'unconfigured values stay last')
  assert.equal(result.props.resetPageKey, 'amount:desc:', 'a sort change restarts paging')
  const html = render(result)
  assert.match(html, /href="\/hrm\/compensation[^"]*sort=amount&amp;dir=asc/, 'the active header links to the reversed sort')
})

test('rows without unique identities and server lists without counts refuse', () => {
  const props = {
    prepared: true as const,
    source: 'data_import_history' as const,
    empty: 'Empty',
    columns: [],
    rowKey: (row: { id: string }) => row.id,
  }
  assert.throws(
    () => PagedTable({ ...props, rows: [{ id: '' }] }),
    /unique stable identities: data_import_history/,
  )
  assert.throws(
    () =>
      PagedTable({
        ...props,
        rows: [{ id: 'duplicate' }, { id: 'duplicate' }],
      }),
    /unique stable identities/,
  )
  assert.throws(
    () => PagedTable({ ...props, source: 'admin_api_keys', rows: [] }),
    /Missing server pagination.*admin_api_keys/,
  )
  assert.throws(
    () => PagedTable({ ...props, source: 'admin_api_keys', rows: [], serverWindow: true }),
    /Missing server pagination.*admin_api_keys/,
  )
  assert.throws(
    () => PagedTable({ ...props, source: 'hrm_compensation_cycles', rows: [], serverWindow: { total: 0, page: 1, perPage: 25 } }),
    /fully loaded record list.*hrm_compensation_cycles/,
  )
})

test('loaded list filters remain beside search when the collection is empty', () => {
  for (const rows of [[], [{ id: 'one', name: 'Employee' }]]) {
    const html = render(
      <PagedTable
        prepared
        searchable
        source="hrm_change_requests"
        rows={rows}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'name',
            header: 'Employee',
            cell: (row) => row.name,
            search: (row) => row.name,
          },
        ]}
        empty="No change requests"
        toolbarAfter={<button>Status filter</button>}
      />,
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
  const html = render(
    <PagedTable
      prepared
      source="hrm_org_chart_directory"
      rows={[]}
      rowKey={(row: { id: string }) => row.id}
      empty="No employees"
      columns={[]}
      serverWindow={{ total: 0, page: 1, perPage: 50 }}
      toolbarAfter={<button>Status</button>}
    />,
  )
  assert.ok(html.indexOf('Status') < html.indexOf('<table'), 'domain controls belong to the shared table toolbar')
  assert.equal(html.includes('perPage='), false, 'fixed readers cannot honor another page size')
  assert.ok(html.includes('No employees'), 'the empty window keeps its spanning row')
})

test('a window without page counts keeps the framed table and no pager', () => {
  const html = render(
    <PagedTable
      prepared
      serverWindow
      source="admin_users"
      rows={[{ id: 'u1', name: 'Ada' }]}
      rowKey={(row) => row.id}
      empty="No users"
      emptyFiltered="No matching users"
      filtersActive
      columns={[{ key: 'name', header: 'Name', cell: (row) => row.name }]}
    />,
  )
  assert.ok(html.includes('rounded-xl border'), 'the server window keeps its frame')
  assert.equal(html.includes('page='), false, 'a window without counts renders no pager')
  assert.equal(html.includes('perPage='), false)
  const empty = render(
    <PagedTable
      prepared
      serverWindow
      source="admin_users"
      rows={[] as { id: string }[]}
      rowKey={(row) => row.id}
      empty="No users"
      emptyFiltered="No matching users"
      filtersActive
      columns={[{ key: 'name', header: 'Name', cell: (row) => row.id }]}
    />,
  )
  assert.ok(empty.includes('No matching users'), 'narrowed windows say nothing matches')
})

test('a host-owned frame and empty state keep the headers and pager of an out-of-range page', () => {
  const html = render(
    <PagedTable
      serverWindow={{ total: 30, page: 9, perPage: 25 }}
      framed={false}
      showPerPage={false}
      basePath="/customers"
      currentParams={{ page: '9' }}
      rows={[] as Record<string, unknown>[]}
      rowKey={(row) => String(row.id)}
      empty={null}
      emptyRow={false}
      columns={[
        {
          key: 'name',
          header: 'Name',
          cell: (row) => String(row.name),
          cellClassName: (row) => (row.name ? 'text-slate-600' : 'text-slate-400'),
        },
      ]}
    />,
  )
  assert.equal(html.includes('rounded-xl border'), false, 'the host owns the frame')
  assert.equal(bodyRows(html), 0, 'no spanning empty row under the headers')
  assert.ok(html.includes('>Name<'), 'the headers remain')
  assert.match(html, /href="\/customers\?page=2"/, 'the pager leads back to the last page')
})

test('per-row cell classes follow the value in every composition', () => {
  const rows = [{ id: 'a', name: '' }, { id: 'b', name: 'Named' }]
  const columns = [{
    key: 'name',
    header: 'Name',
    className: 'fallback',
    cell: (row: { id: string; name: string }) => row.name || '—',
    cellClassName: (row: { id: string; name: string }) => (row.name ? undefined : 'text-slate-400'),
  }]
  const windowHtml = render(
    <PagedTable serverWindow={{ total: 2, page: 1, perPage: 25 }} basePath="/x" currentParams={{}}
      rows={rows} rowKey={(row) => row.id} empty="Empty" columns={columns} />,
  )
  const prepared = render(
    <PagedTable prepared source="hrm_compensation_cycles" rows={rows} rowKey={(row) => row.id} empty="Empty" columns={columns} />,
  )
  for (const html of [windowHtml, prepared]) {
    assert.match(html, /<td[^>]*class="[^"]*text-slate-400[^"]*"[^>]*>—<\/td>/, 'an empty value renders muted')
    assert.match(html, /<td[^>]*class="[^"]*fallback[^"]*"[^>]*>Named<\/td>/, 'other rows keep the column class')
  }
})
