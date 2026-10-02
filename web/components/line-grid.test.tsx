import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from '../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../testing/jsdom-env.ts'

// Structural edits must keep uncommitted quantities and tax overrides on
// their own lines. Render the real grid and shared menus with real messages.
await bootJsdomEnvironment({ url: 'http://localhost:4800/ap/bills', matchMediaMatches: false });
stubModules({
  navigation: { pathname: '/ap/bills' },
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
    sonner: 'export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}',
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { useState } = React;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { LineGrid } = await import("./line-grid");
type LineGridColumn<Row extends Record<string, unknown>> = import("./line-grid").LineGridColumn<Row>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

interface TestRow extends Record<string, unknown> {
  clientKey: string;
  description: string;
  quantity: string;
  taxAmount: string;
  taxOverridden: boolean;
  itemId?: string;
  stockLocationId?: string;
}

const store: { rows: TestRow[]; splitIndex: number | null } = { rows: [], splitIndex: null };

test("editable cells are named by their column header and line number", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2")]);
  t.after(done);

  assert.ok(host.querySelector('[role="grid"]'), "the line editor exposes grid semantics");
  assert.ok(host.querySelector('[role="columnheader"]'), "column captions expose header semantics");
  const input = cellInput(host, 1, 0);
  const labels = input.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  assert.equal(labels.length, 2, "each input references its column and row labels");
  const labelText = labels.map((id) => document.getElementById(id)?.textContent?.trim());
  assert.deepEqual(labelText, ["Qty", "Line 2 actions"]);
  const selectors = [...host.querySelectorAll('div[data-lg-row="1"] button[aria-haspopup="listbox"]')];
  assert.equal(selectors.length, 2, "the search-select and select triggers render");
  for (const selector of selectors) {
    const selectorLabels = selector.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
    assert.equal(selectorLabels.length, 2, "each selector references its column and row labels");
    assert.ok(selectorLabels.every((id) => document.getElementById(id)?.textContent?.trim()), "each selector label reference resolves");
  }
});

function Probe({ initial, compact = false, readOnly = false, withDistribution = false }: { initial: TestRow[]; compact?: boolean; readOnly?: boolean; withDistribution?: boolean }) {
  const [rows, setRows] = useState(initial);
  const apply = (next: TestRow[]) => {
    store.rows = next;
    setRows(next);
  };
  const columns: LineGridColumn<TestRow>[] = [
    { key: "quantity", label: "Qty", width: "110px", type: "decimal", decimalScale: 8 },
    {
      key: "taxAmount",
      label: "Tax",
      width: "120px",
      type: "tax",
      align: "right",
      computeTax: () => "0.0000",
      onTaxChange: (index, next) =>
        apply(store.rows.map((r, j) => (j === index ? { ...r, taxAmount: next.taxAmount, taxOverridden: next.overridden } : r))),
    },
    { key: "category", label: "Category", width: "140px", type: "search-select", options: [{ value: "goods", label: "Goods" }] },
    { key: "kind", label: "Kind", width: "120px", type: "select", options: [{ value: "expense", label: "Expense" }] },
    {
      key: "stockLocationId",
      label: "Warehouse",
      width: "150px",
      type: "select",
      options: [{ value: "", label: "—" }, { value: "loc-1", label: "North" }],
      isCellEditable: (row) => row.itemId === "stocked-item",
    },
  ];
  if (compact) columns.push({ key: 'description', label: 'Details text', width: '120px', type: 'text', secondary: true });
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <LineGrid<TestRow>
        columns={columns}
        rows={rows}
        readOnly={readOnly}
        getRowKey={(row) => row.clientKey}
        cloneRow={(row) => ({ ...row, clientKey: `copy-${row.clientKey}` })}
        distribution={withDistribution ? {
          groups: [], groupedIndexes: new Set(), chipOf: () => ({ kind: 'split' }),
          menuKeysOf: () => ['split'], groupKeyOf: () => null,
          onSplit: (index) => { store.splitIndex = index; },
          onUnsplit: () => {}, onToggleLock: () => {}, onApplySuggestion: () => {}, onEditGroupTotal: () => {},
        } : undefined}
        onRowsChange={(next) => apply(next)}
        emptyRow={() => ({ clientKey: `new-${Date.now()}`, description: "", quantity: "", taxAmount: "", taxOverridden: false })}
      />
    </NextIntlClientProvider>
  );
}

async function mount(initial: TestRow[], compact = false, readOnly = false, withDistribution = false) {
  store.rows = initial;
  store.splitIndex = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe initial={initial} compact={compact} readOnly={readOnly} withDistribution={withDistribution} />);
    await tick();
  });
  await tick();
  return {
    host,
    async done() {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function cellInput(host: HTMLElement, row: number, col: number): HTMLInputElement {
  const cell = host.querySelector(`div[data-lg-row="${row}"][data-lg-col="${col}"]`);
  assert.ok(cell, `row ${row} col ${col} must render a cell`);
  const input = cell.querySelector("input");
  assert.ok(input, `row ${row} col ${col} must render an input`);
  return input as HTMLInputElement;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function interact(action: () => void) {
  await act(async () => { action(); await tick(); });
  await tick();
}

async function keydown(el: Element, init: KeyboardEventInit) {
  await interact(() => { el.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });
}

async function blur(el: HTMLInputElement) {
  await interact(() => el.blur());
}

const line = (key: string, quantity: string): TestRow => ({
  clientKey: key,
  description: `line ${key}`,
  quantity,
  taxAmount: "",
  taxOverridden: false,
});

function menuAction(label: string): HTMLButtonElement {
  const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim() === label);
  assert.ok(action, `the shared context menu exposes ${label}`);
  return action;
}

test('the visible line action button removes the selected line and preserves its neighbours', async (t) => {
  const { host, done } = await mount([line('a', '1'), line('b', '2'), line('c', '3')]);
  t.after(done);
  const input = cellInput(host, 1, 0);
  await typeInto(input, '7');
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Line 2 actions"]')!;
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  await act(async () => { trigger.click(); await tick(); });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  await act(async () => { menuAction('Remove line').click(); await tick(); });
  await blur(input);
  assert.deepEqual(store.rows.map((row) => [row.clientKey, row.quantity]), [['a', '1'], ['c', '3']]);
});

test('right-click opens line actions on an editable cell and the last line can be cleared', async (t) => {
  const { host, done } = await mount([line('a', '1')]);
  t.after(done);
  const input = cellInput(host, 0, 0);
  let nativeMenuAllowed = true;
  await act(async () => {
    nativeMenuAllowed = input.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100,
    }));
    await tick();
  });
  assert.equal(nativeMenuAllowed, false, 'the row opens the shared menu instead of the browser menu');
  assert.equal(menuAction('Insert above').disabled, false);
  assert.equal(menuAction('Duplicate').disabled, false);
  await act(async () => { menuAction('Clear line').click(); await tick(); });
  assert.equal(store.rows.length, 1, 'the minimum row remains');
  assert.equal(store.rows[0]!.description, '');
  assert.equal(store.rows[0]!.quantity, '');
});

test('a keyboard context menu keeps its target when the line is reordered', async (t) => {
  const { host, done } = await mount([line('a', '1'), line('b', '2'), line('c', '3')]);
  t.after(done);
  const input = cellInput(host, 1, 0);
  await keydown(input, { key: 'F10', shiftKey: true });
  assert.ok(menuAction('Remove line'));
  await keydown(input, { key: 'ArrowDown', altKey: true });
  await act(async () => { menuAction('Remove line').click(); await tick(); });
  assert.deepEqual(store.rows.map((row) => row.clientKey), ['a', 'c'], 'actions follow the line identity');
});

test('read-only lines expose no editing actions or custom right-click menu', async (t) => {
  const { host, done } = await mount([line('a', '1')], false, true);
  t.after(done);
  assert.equal(host.querySelector('button[aria-haspopup="menu"]'), null);
  const row = host.querySelectorAll('[role="row"]')[1]!;
  let nativeMenuAllowed = false;
  await act(async () => {
    nativeMenuAllowed = row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await tick();
  });
  assert.equal(nativeMenuAllowed, true);
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.deepEqual(store.rows.map((row) => row.clientKey), ['a']);
});

test('distribution actions and line removal share one context menu', async (t) => {
  const { host, done } = await mount([line('a', '1'), line('b', '2')], false, false, true);
  t.after(done);
  const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => button.textContent?.includes('Split…'))[1]!;
  await act(async () => { trigger.click(); await tick(); });
  assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
  assert.ok(menuAction('Remove line'));
  await act(async () => { menuAction('Split…').click(); await tick(); });
  assert.equal(store.splitIndex, 1, 'splitting addresses the selected line');
  assert.deepEqual(store.rows.map((row) => row.clientKey), ['a', 'b']);
});

test('optional columns expand on demand and populated values remain visible when collapsed', async (t) => {
  const { host, done } = await mount([{ ...line('a', '1'), description: '' }], true);
  t.after(done);
  const hasDetails = () => [...host.querySelectorAll('[role="columnheader"]')].some((header) => header.textContent === 'Details text');
  assert.equal(hasDetails(), false, 'empty optional columns start collapsed');
  const toggle = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Details')!;
  await act(async () => { toggle.click(); await tick(); });
  assert.equal(hasDetails(), true);
  await typeInto(cellInput(host, 0, 5), 'Keep this description');
  await act(async () => { toggle.click(); await tick(); });
  assert.equal(hasDetails(), true, 'a populated column is never concealed');
  assert.equal(store.rows[0]!.description, 'Keep this description', 'collapsing changes no transaction values');
});

test("a row edit gate exposes the warehouse picker only on applicable lines", async (t) => {
  const { host, done } = await mount([
    { ...line("stocked", "1"), itemId: "stocked-item", stockLocationId: "loc-1" },
    { ...line("service", "2"), itemId: "service-item", stockLocationId: "" },
  ]);
  t.after(done);

  assert.ok(host.querySelector('[data-lg-row="0"][data-lg-col="4"] button'), "stocked line has an editable warehouse control");
  assert.equal(host.querySelector('[data-lg-row="1"][data-lg-col="4"]'), null, "non-stocked line has no warehouse control");
});

test("Alt+Up keeps the moved line's typed qty off its neighbour", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2"), line("c", "3")]);
  t.after(done);
  const input = cellInput(host, 2, 0);
  await typeInto(input, "9");
  const cell = host.querySelector('div[data-lg-row="2"][data-lg-col="0"]')!;
  await keydown(cell, { key: "ArrowUp", altKey: true });
  await blur(input);
  const rows = store.rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.clientKey, "a");
  assert.equal(rows[1]!.clientKey, "c", "the edited line moves up");
  assert.ok(String(rows[1]!.quantity).startsWith("9"), `the moved line keeps its typed qty, got ${rows[1]!.quantity}`);
  assert.equal(rows[2]!.clientKey, "b");
  assert.equal(rows[2]!.quantity, "2", `the neighbour line keeps its qty, got ${rows[2]!.quantity}`);
});

test("Ctrl+Backspace keeps the surviving line's qty", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2"), line("c", "3")]);
  t.after(done);
  const input = cellInput(host, 1, 0);
  await typeInto(input, "7");
  const cell = host.querySelector('div[data-lg-row="1"][data-lg-col="0"]')!;
  await keydown(cell, { key: "Backspace", ctrlKey: true });
  await blur(input);
  const rows = store.rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.clientKey), ["a", "c"]);
  assert.equal(rows[0]!.quantity, "1");
  assert.equal(rows[1]!.quantity, "3", `the line after the deletion keeps its qty, got ${rows[1]!.quantity}`);
});

test("Alt+Down keeps an uncommitted tax override on its own line", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2")]);
  t.after(done);
  const input = cellInput(host, 0, 1);
  await typeInto(input, "5");
  const cell = host.querySelector('div[data-lg-row="0"][data-lg-col="1"]')!;
  await keydown(cell, { key: "ArrowDown", altKey: true });
  await blur(input);
  const rows = store.rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.clientKey, "b");
  assert.equal(rows[0]!.taxOverridden, false, "the line moving up must not inherit the override");
  assert.equal(rows[0]!.taxAmount, "");
  assert.equal(rows[1]!.clientKey, "a");
  assert.equal(rows[1]!.taxOverridden, true, "the moved line keeps its override");
  assert.ok(String(rows[1]!.taxAmount).startsWith("5"), `the moved line keeps its override amount, got ${rows[1]!.taxAmount}`);
});
