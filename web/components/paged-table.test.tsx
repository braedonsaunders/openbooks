import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// jsdom first: the table reads browser globals at render.
await bootJsdomEnvironment({
  url: 'http://localhost:4800/ar/invoices',
  matchMediaMatches: false,
})

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { PagedTable } = await import("./paged-table");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

test('a registered server window is never paginated a second time', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  const rows = Array.from({ length: 25 }, (_, index) => ({
    id: String(index),
    name: `Window row ${index}`,
  }))
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PagedTable
          source="inbox_approvals"
          rows={rows}
          pageSize={10}
          searchable
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (row) => row.name,
              search: (row) => row.name,
            },
          ]}
          rowKey={(row) => row.id}
          empty="Empty"
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  assert.equal(host.querySelectorAll('tbody tr').length, 25)
  assert.equal(
    host.querySelector('input'),
    null,
    'window search belongs to the server source',
  )
  assert.ok(host.textContent?.includes('Window row 24'))
})

interface Row {
  id: string;
  name: string;
}

const opened: string[] = [];
const acted: string[] = [];
const toggled: string[] = [];

async function mountTable() {
  opened.length = 0
  acted.length = 0
  toggled.length = 0
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PagedTable<Row>
          rows={[
            { id: 'a', name: 'Alpha' },
            { id: 'b', name: 'Beta' },
          ]}
          columns={[
            {
              key: 'name',
              header: 'Name',
              cell: (row) => (
                <span data-testid={`cell-${row.id}`}>{row.name}</span>
              ),
            },
            {
              key: 'act',
              header: 'Act',
              cell: (row) => (
                <button
                  type="button"
                  data-testid={`act-${row.id}`}
                  onClick={() => acted.push(row.id)}
                >
                  Go
                </button>
              ),
            },
          ]}
          empty="empty"
          rowKey={(row) => row.id}
          onRowClick={(row) => opened.push(row.id)}
          selection={{
            getId: (row) => row.id,
            selectedIds: [],
            onToggle: (id) => toggled.push(id),
            onToggleAll: () => {},
          }}
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await tick();
  });
  await tick();
}

function rowActionButton(id: string): HTMLButtonElement {
  const el = document.querySelector(`[data-testid="act-${id}"]`)
  assert.ok(el, `action button for row ${id} renders`)
  return el as HTMLButtonElement
}

test("clicking a row action button fires the action and never the row-open", async () => {
  const table = await mountTable();
  try {
    await click(rowActionButton("a"));
    assert.deepEqual(acted, ["a"]);
    assert.deepEqual(opened, [], "the row drawer must not open over the action");
  } finally {
    await table.unmount();
  }
});

test('plain cells open the row and focused rows support keyboard activation', async () => {
  const table = await mountTable()
  try {
    const cell = document.querySelector('[data-testid="cell-b"]') as HTMLElement
    const row = cell.closest('tr')
    assert.ok(row)
    await click(row)
    assert.deepEqual(opened, ['b'])
    assert.equal(row.getAttribute('tabindex'), '0')
    row.focus()
    await act(async () =>
      row.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    )
    assert.deepEqual(opened, ['b', 'b'])
  } finally {
    await table.unmount()
  }
})

test('the selection checkbox toggles without opening the row', async () => {
  const table = await mountTable()
  try {
    const checkbox = document.querySelector(
      'tbody input[type="checkbox"]',
    ) as HTMLInputElement
    await click(checkbox)
    assert.deepEqual(toggled, ['a'])
    assert.deepEqual(opened, [], 'selecting a row must not open it')
  } finally {
    await table.unmount()
  }
})

test("keyboard activation on a focused action button runs only that action", async () => {
  const table = await mountTable();
  try {
    // Enter/Space on a focused button fires a click targeted at the button —
    // the same event a real keypress produces — so the action runs alone.
    const button = rowActionButton("b");
    button.focus();
    await click(button);
    assert.deepEqual(acted, ["b"]);
    assert.deepEqual(opened, []);
  } finally {
    await table.unmount();
  }
});

test('a server window ignores client search retained from a previous collection', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  const rows = Array.from({ length: 25 }, (_, index) => ({ id: String(index), name: `Window row ${index}` }))
  const render = async (source: 'payroll_opening_employees' | 'inbox_approvals') => {
    await act(async () => { root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <PagedTable source={source} rows={rows} searchable rowKey={(row) => row.id} empty="Empty"
        columns={[{ key: 'name', header: 'Name', cell: (row) => row.name, search: (row) => row.name }]} />
    </NextIntlClientProvider>); await tick() })
  }
  await render('payroll_opening_employees')
  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Window row 24')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await tick()
  })
  assert.equal(host.querySelectorAll('tbody tr').length, 1, 'the loaded collection must actually have a client filter')
  await render('inbox_approvals')
  assert.equal(host.querySelectorAll('tbody tr').length, 25, 'a server window must ignore retained client search')
  assert.equal(host.querySelector('input'), null)
})


test('registered lists retain search and domain filters when a filter returns no rows', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PagedTable<Row>
          source="property_rent_roll" rows={[]} rowKey={(row) => row.id}
          columns={[{ key: 'name', header: 'Tenant', cell: (row) => row.name, search: (row) => row.name }]}
          searchable empty="No matching leases"
          toolbarAfter={<button>Reset property filter</button>}
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  assert.ok(host.querySelector('input[aria-label="Search"]'), 'search remains usable for an empty collection')
  assert.ok([...host.querySelectorAll('button')].some((button) => button.textContent === 'Reset property filter'), 'operators can recover from an empty filtered collection')
  assert.ok(host.querySelector('thead')?.textContent?.includes('Tenant'))
  assert.ok(host.querySelector('tbody')?.textContent?.includes('No matching leases'))
})

test("a button-role record row opens from its cells and keyboard without treating itself as a nested control", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened: string[] = [];
  try {
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <PagedTable
            rows={[{ id: "record", name: "Sales representative" }]}
            columns={[
              {
                key: "name",
                header: "Name",
                cell: (row) => <span>{row.name}</span>,
              },
            ]}
            rowKey={(row) => row.id}
            empty="Empty"
            onRowClick={(row) => opened.push(row.id)}
          />
        </NextIntlClientProvider>,
      ),
    );
    const row = host.querySelector("tbody tr") as HTMLElement;
    assert.equal(row.getAttribute("role"), "button");
    await act(async () => row.querySelector("span")!.click());
    assert.deepEqual(opened, ["record"]);
    await act(async () =>
      row.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    assert.deepEqual(opened, ["record", "record"]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('row interactivity scopes click and keyboard opens without changing the default table contract', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const opened: string[] = []
  t.after(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <PagedTable source="projects_prebills"
        rows={[{ id: 'readonly', name: 'Unbilled project' }, { id: 'open', name: 'Worksheet' }]}
        columns={[{ key: 'name', header: 'Work', cell: (row) => row.name }]}
        rowKey={(row) => row.id} empty="Empty"
        onRowClick={(row) => opened.push(row.id)} rowInteractive={(row) => row.id === 'open'} />
    </NextIntlClientProvider>)
    await tick()
  })
  const rows = host.querySelectorAll<HTMLTableRowElement>('tbody tr')
  assert.equal(rows[0]!.getAttribute('tabindex'), null)
  assert.equal(rows[0]!.getAttribute('role'), null)
  assert.equal(rows[1]!.getAttribute('tabindex'), '0')
  await act(async () => {
    rows[0]!.click()
    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
  })
  assert.deepEqual(opened, [])
  await act(async () => {
    rows[1]!.click()
    rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
  })
  assert.deepEqual(opened, ['open', 'open'])
})

test('inside a record drawer the search stretches across the drawer beside its filters', async (t) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  t.after(async () => {
    await act(async () => root.unmount())
    host.remove()
  })
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PagedTable
          rows={[{ id: '1', name: 'Foundation' }]}
          searchable
          searchLayout="drawer"
          toolbarAfter={<select aria-label="Status"><option>All</option></select>}
          columns={[{ key: 'name', header: 'Name', cell: (row) => row.name, search: (row) => row.name }]}
          rowKey={(row) => row.id}
          empty="Empty"
        />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  const toolbar = host.querySelector('[data-sublist-toolbar]')
  assert.ok(toolbar?.className.split(/\s+/).includes('w-full'), 'the toolbar spans the drawer')
  const search = toolbar?.querySelector('[data-sublist-search]')
  assert.ok(search?.className.split(/\s+/).includes('flex-1'), 'the search grows to fill the row')
  assert.ok(!search?.className.includes('max-w'), 'the drawer search is never capped')
  assert.ok(toolbar?.querySelector('select[aria-label="Status"]'), 'filters sit beside the search')
})
