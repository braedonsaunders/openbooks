import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// Structural edits must keep uncommitted quantities and tax overrides on
// their own lines. Render the real grid and shared menus with real messages.
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: false });
stubModules({
  navigation: { pathname: "/ap/bills" },
  extra: {
    "next/link": "export default function Link(p){return p.children}",
    sonner:
      "export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
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
const businessDate = await import("./business-date-provider");
type LineGridColumn<Row extends Record<string, unknown>> =
  import("./line-grid").LineGridColumn<Row>;

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
  const selectors = [
    ...host.querySelectorAll('div[data-lg-row="1"] button[aria-haspopup="listbox"]'),
  ];
  assert.equal(selectors.length, 2, "the search-select and select triggers render");
  for (const selector of selectors) {
    const selectorLabels = selector.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
    assert.equal(selectorLabels.length, 2, "each selector references its column and row labels");
    assert.ok(
      selectorLabels.every((id) => document.getElementById(id)?.textContent?.trim()),
      "each selector label reference resolves",
    );
  }
});

function Probe({
  initial,
  compact = false,
  readOnly = false,
  withDistribution = false,
  hideRemove = false,
}: {
  initial: TestRow[];
  compact?: boolean;
  readOnly?: boolean;
  withDistribution?: boolean;
  hideRemove?: boolean;
}) {
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
        apply(
          store.rows.map((r, j) =>
            j === index ? { ...r, taxAmount: next.taxAmount, taxOverridden: next.overridden } : r,
          ),
        ),
    },
    {
      key: "category",
      label: "Category",
      width: "140px",
      type: "search-select",
      options: [{ value: "goods", label: "Goods" }],
    },
    {
      key: "kind",
      label: "Kind",
      width: "120px",
      type: "select",
      options: [{ value: "expense", label: "Expense" }],
    },
    {
      key: "stockLocationId",
      label: "Warehouse",
      width: "150px",
      type: "select",
      options: [
        { value: "", label: "—" },
        { value: "loc-1", label: "North" },
      ],
      isCellEditable: (row) => row.itemId === "stocked-item",
    },
  ];
  if (compact)
    columns.push({
      key: "description",
      label: "Details text",
      width: "120px",
      type: "text",
      secondary: true,
    });
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <LineGrid<TestRow>
        columns={columns}
        rows={rows}
        readOnly={readOnly}
        hideRemove={hideRemove}
        getRowKey={(row) => row.clientKey}
        cloneRow={(row) => ({ ...row, clientKey: `copy-${row.clientKey}` })}
        distribution={
          withDistribution
            ? {
                groups: [],
                groupedIndexes: new Set(),
                chipOf: () => ({ kind: "split" }),
                menuKeysOf: () => ["split"],
                groupKeyOf: () => null,
                onSplit: (index) => {
                  store.splitIndex = index;
                },
                onUnsplit: () => {},
                onToggleLock: () => {},
                onApplySuggestion: () => {},
                onEditGroupTotal: () => {},
              }
            : undefined
        }
        onRowsChange={(next) => apply(next)}
        emptyRow={() => ({
          clientKey: `new-${Date.now()}`,
          description: "",
          quantity: "",
          taxAmount: "",
          taxOverridden: false,
        })}
      />
    </NextIntlClientProvider>
  );
}

async function mount(
  initial: TestRow[],
  compact = false,
  readOnly = false,
  withDistribution = false,
  hideRemove = false,
) {
  store.rows = initial;
  store.splitIndex = null;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <Probe
        initial={initial}
        compact={compact}
        readOnly={readOnly}
        withDistribution={withDistribution}
        hideRemove={hideRemove}
      />,
    );
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
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  await tick();
}

async function interact(action: () => void) {
  await act(async () => {
    action();
    await tick();
  });
  await tick();
}

async function keydown(el: Element, init: KeyboardEventInit) {
  await interact(() => {
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
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
  const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (button) => button.textContent?.trim() === label,
  );
  assert.ok(action, `the shared context menu exposes ${label}`);
  return action;
}

test("the visible line action button removes the selected line and preserves its neighbours", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2"), line("c", "3")]);
  t.after(done);
  const input = cellInput(host, 1, 0);
  await typeInto(input, "7");
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Line 2 actions"]')!;
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  await act(async () => {
    trigger.click();
    await tick();
  });
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  await act(async () => {
    menuAction("Remove line").click();
    await tick();
  });
  await blur(input);
  assert.deepEqual(
    store.rows.map((row) => [row.clientKey, row.quantity]),
    [
      ["a", "1"],
      ["c", "3"],
    ],
  );
});

test("right-click opens line actions on an editable cell and the last line can be cleared", async (t) => {
  const { host, done } = await mount([line("a", "1")]);
  t.after(done);
  const input = cellInput(host, 0, 0);
  let nativeMenuAllowed = true;
  await act(async () => {
    nativeMenuAllowed = input.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 100,
      }),
    );
    await tick();
  });
  assert.equal(
    nativeMenuAllowed,
    false,
    "the row opens the shared menu instead of the browser menu",
  );
  assert.equal(menuAction("Insert above").disabled, false);
  assert.equal(menuAction("Duplicate").disabled, false);
  await act(async () => {
    menuAction("Clear line").click();
    await tick();
  });
  assert.equal(store.rows.length, 1, "the minimum row remains");
  assert.equal(store.rows[0]!.description, "");
  assert.equal(store.rows[0]!.quantity, "");
});

test("hideRemove preserves editable lines without offering menu or keyboard deletion", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2")], false, false, false, true);
  t.after(done);
  const input = cellInput(host, 0, 0);
  await keydown(input, { key: "Backspace", ctrlKey: true });
  assert.deepEqual(
    store.rows.map((row) => row.clientKey),
    ["a", "b"],
  );
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Line 1 actions"]')!;
  await act(async () => {
    trigger.click();
    await tick();
  });
  assert.ok(menuAction("Insert above"), "other line actions remain available");
  assert.equal(
    [...document.querySelectorAll('[role="menuitem"]')].some(
      (item) => item.textContent?.trim() === "Remove line",
    ),
    false,
  );
  assert.deepEqual(
    store.rows.map((row) => row.clientKey),
    ["a", "b"],
  );
});

test("a keyboard context menu keeps its target when the line is reordered", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2"), line("c", "3")]);
  t.after(done);
  const input = cellInput(host, 1, 0);
  await keydown(input, { key: "F10", shiftKey: true });
  assert.ok(menuAction("Remove line"));
  await keydown(input, { key: "ArrowDown", altKey: true });
  await act(async () => {
    menuAction("Remove line").click();
    await tick();
  });
  assert.deepEqual(
    store.rows.map((row) => row.clientKey),
    ["a", "c"],
    "actions follow the line identity",
  );
});

test("read-only lines expose no editing actions or custom right-click menu", async (t) => {
  const { host, done } = await mount([line("a", "1")], false, true);
  t.after(done);
  assert.equal(host.querySelector('button[aria-haspopup="menu"]'), null);
  const row = host.querySelectorAll('[role="row"]')[1]!;
  let nativeMenuAllowed = false;
  await act(async () => {
    nativeMenuAllowed = row.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
  });
  assert.equal(nativeMenuAllowed, true);
  assert.equal(document.querySelector('[role="menu"]'), null);
  assert.deepEqual(
    store.rows.map((row) => row.clientKey),
    ["a"],
  );
});

test("distribution actions and line removal share one context menu", async (t) => {
  const { host, done } = await mount([line("a", "1"), line("b", "2")], false, false, true);
  t.after(done);
  const trigger = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    button.textContent?.includes("Split…"),
  )[1]!;
  await act(async () => {
    trigger.click();
    await tick();
  });
  assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
  assert.ok(menuAction("Remove line"));
  await act(async () => {
    menuAction("Split…").click();
    await tick();
  });
  assert.equal(store.splitIndex, 1, "splitting addresses the selected line");
  assert.deepEqual(
    store.rows.map((row) => row.clientKey),
    ["a", "b"],
  );
});

test("optional columns expand on demand and populated values remain visible when collapsed", async (t) => {
  const { host, done } = await mount([{ ...line("a", "1"), description: "" }], true);
  t.after(done);
  const hasDetails = () =>
    [...host.querySelectorAll('[role="columnheader"]')].some(
      (header) => header.textContent === "Details text",
    );
  assert.equal(hasDetails(), false, "empty optional columns start collapsed");
  const toggle = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Details",
  )!;
  await act(async () => {
    toggle.click();
    await tick();
  });
  assert.equal(hasDetails(), true);
  await typeInto(cellInput(host, 0, 5), "Keep this description");
  await act(async () => {
    toggle.click();
    await tick();
  });
  assert.equal(hasDetails(), true, "a populated column is never concealed");
  assert.equal(
    store.rows[0]!.description,
    "Keep this description",
    "collapsing changes no transaction values",
  );
});

test("a row edit gate exposes the warehouse picker only on applicable lines", async (t) => {
  const { host, done } = await mount([
    { ...line("stocked", "1"), itemId: "stocked-item", stockLocationId: "loc-1" },
    { ...line("service", "2"), itemId: "service-item", stockLocationId: "" },
  ]);
  t.after(done);

  assert.ok(
    host.querySelector('[data-lg-row="0"][data-lg-col="4"] button'),
    "stocked line has an editable warehouse control",
  );
  const gated = host.querySelector('[data-lg-row="1"][data-lg-col="4"]');
  assert.ok(gated, "the gated row still renders the warehouse cell position");
  assert.equal(
    gated.querySelector("button, input, select"),
    null,
    "the gated cell offers no control",
  );
});

test("every declared column renders a cell on every row, gated or read-only", async (_t) => {
  const rows = [
    { ...line("stocked", "1"), itemId: "stocked-item", stockLocationId: "loc-1" },
    { ...line("service", "2"), itemId: "service-item", stockLocationId: "" },
  ];
  for (const readOnly of [false, true]) {
    const { host, done } = await mount(rows, false, readOnly);
    try {
      const bodyRows = [...host.querySelectorAll('[role="row"]')].slice(1);
      assert.equal(bodyRows.length, 2, "both lines render");
      for (const [n, row] of bodyRows.entries()) {
        assert.equal(
          row.querySelectorAll(':scope > [role="gridcell"]').length,
          5,
          `row ${n} renders a cell for every declared column (readOnly=${readOnly})`,
        );
      }
    } finally {
      await done();
    }
  }
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
  assert.ok(
    String(rows[1]!.quantity).startsWith("9"),
    `the moved line keeps its typed qty, got ${rows[1]!.quantity}`,
  );
  assert.equal(rows[2]!.clientKey, "b");
  assert.equal(
    rows[2]!.quantity,
    "2",
    `the neighbour line keeps its qty, got ${rows[2]!.quantity}`,
  );
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
  assert.deepEqual(
    rows.map((r) => r.clientKey),
    ["a", "c"],
  );
  assert.equal(rows[0]!.quantity, "1");
  assert.equal(
    rows[1]!.quantity,
    "3",
    `the line after the deletion keeps its qty, got ${rows[1]!.quantity}`,
  );
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
  assert.ok(
    String(rows[1]!.taxAmount).startsWith("5"),
    `the moved line keeps its override amount, got ${rows[1]!.taxAmount}`,
  );
});

test("opt-in selection renders checkboxes bound to row identities", async (t) => {
  const seen: ReadonlySet<string>[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const rows = [line("a", "1"), line("b", "2")];
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <LineGrid<TestRow>
          columns={[
            { key: "quantity", label: "Qty", width: "110px", type: "decimal", decimalScale: 8 },
          ]}
          rows={rows}
          onRowsChange={() => {}}
          emptyRow={() => line("z", "")}
          readOnly
          minRows={0}
          getRowKey={(row) => row.clientKey}
          selection={{
            selected: new Set(["a"]),
            onChange: (next) => {
              seen.push(next);
            },
          }}
        />
      </NextIntlClientProvider>,
    );
    await tick();
  });
  await tick();
  t.after(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
  const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
  assert.equal(boxes.length, 3, "header select-all plus one box per row");
  assert.equal(boxes[1]!.checked, true, "the selected row renders checked");
  assert.equal(boxes[2]!.checked, false, "the unselected row renders unchecked");
  await act(async () => {
    boxes[2]!.click();
    await tick();
  });
  await tick();
  assert.deepEqual([...(seen[0] ?? [])].sort(), ["a", "b"], "toggling a row adds its identity");
});

async function mountTaxCell(computeTax: () => string, readOnly: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const columns: LineGridColumn<TestRow>[] = [
    {
      key: "taxAmount",
      label: "Tax amt",
      width: "120px",
      type: "tax",
      align: "right",
      computeTax,
      onTaxChange: () => {},
    },
  ];
  const rows: TestRow[] = [
    { clientKey: "l1", description: "untaxed", quantity: "1", taxAmount: "", taxOverridden: false },
  ];
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <LineGrid<TestRow>
          columns={columns}
          rows={rows}
          readOnly={readOnly}
          getRowKey={(row) => row.clientKey}
          cloneRow={(row) => ({ ...row })}
          onRowsChange={() => {}}
          emptyRow={() => ({
            clientKey: "new",
            description: "",
            quantity: "",
            taxAmount: "",
            taxOverridden: false,
          })}
        />
      </NextIntlClientProvider>,
    );
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

test("a leaked tax error code renders as a dash, never the code", async (t) => {
  const viewing = await mountTaxCell(() => "not_found", true);
  t.after(viewing.done);
  assert.ok(
    viewing.host.textContent?.includes("—"),
    "a read-only tax cell shows a dash for an error code",
  );
  assert.ok(
    !viewing.host.textContent?.includes("not_found"),
    "a read-only tax cell never leaks the code",
  );

  const editing = await mountTaxCell(() => "not_found", false);
  t.after(editing.done);
  const input = editing.host.querySelector('div[data-lg-row="0"] input') as HTMLInputElement | null;
  assert.ok(input, "the edit-mode tax cell renders");
  assert.equal(input.value, "—", "an edit-mode tax cell shows a dash for an error code");
});

test("real and zero tax amounts keep their established display", async (t) => {
  const viewing = await mountTaxCell(() => "5.0000", true);
  t.after(viewing.done);
  assert.ok(viewing.host.textContent?.includes("5.0000"), "a real computed amount still renders");
  assert.ok(!viewing.host.textContent?.includes("—"), "a real amount is not dashed");

  const zero = await mountTaxCell(() => "0.0000", true);
  t.after(zero.done);
  assert.ok(!zero.host.textContent?.includes("—"), "an untaxed line keeps its empty cell");
  assert.ok(!zero.host.textContent?.includes("0.00"), "an untaxed line keeps zero suppressed");
});

interface DatedRow extends Record<string, unknown> {
  clientKey: string;
  workFrom: string;
}

const dated: { rows: DatedRow[] } = { rows: [] };

function DatedProbe({ initial }: { initial: DatedRow[] }) {
  const [rows, setRows] = useState(initial);
  const { BusinessDateProvider } = businessDate;
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <BusinessDateProvider today="2026-10-17">
        <LineGrid<DatedRow>
          columns={[{ key: "workFrom", label: "Work from", width: "130px", type: "date" }]}
          rows={rows}
          getRowKey={(row) => row.clientKey}
          cloneRow={(row) => ({ ...row, clientKey: `copy-${row.clientKey}` })}
          onRowsChange={(next) => {
            dated.rows = next;
            setRows(next);
          }}
          emptyRow={() => ({ clientKey: `new-${dated.rows.length}`, workFrom: "" })}
        />
      </BusinessDateProvider>
    </NextIntlClientProvider>
  );
}

test("date columns read typed dates and keys, and keep the grid's row commands", async (t) => {
  dated.rows = [
    { clientKey: "a", workFrom: "2026-01-05" },
    { clientKey: "b", workFrom: "" },
  ];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<DatedProbe initial={dated.rows} />);
    await tick();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const first = cellInput(host, 0, 0);
  assert.equal(first.value, "01/05/2026", "a stored date shows in the viewer format");
  assert.ok(first.getAttribute("aria-labelledby"), "the date cell is named by its column and line");

  const second = cellInput(host, 1, 0);
  await typeInto(second, "3/15");
  await blur(second);
  assert.equal(
    dated.rows[1]!.workFrom,
    "2026-03-15",
    "a yearless entry reads in the business year",
  );
  await act(async () => second.focus());
  await keydown(second, { key: "+" });
  assert.equal(dated.rows[1]!.workFrom, "2026-03-16");

  await typeInto(second, "2/30/2026");
  await keydown(second, { key: "Enter" });
  assert.equal(dated.rows.length, 2, "a refused date keeps focus instead of adding a line");
  assert.equal(dated.rows[1]!.workFrom, "", "the refused text reports no date");
  assert.equal(cellInput(host, 1, 0).getAttribute("aria-invalid"), "true");

  await typeInto(second, "4/1/2026");
  const cell = host.querySelector('div[data-lg-row="1"][data-lg-col="0"]')!;
  await keydown(cell, { key: "ArrowUp", altKey: true });
  await blur(second);
  assert.deepEqual(
    dated.rows.map((row) => [row.clientKey, row.workFrom]),
    [
      ["b", "2026-04-01"],
      ["a", "2026-01-05"],
    ],
    "Alt+Up moves the line with its typed date",
  );
});
