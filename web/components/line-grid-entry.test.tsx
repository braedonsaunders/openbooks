import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";
import { bootJsdomEnvironment } from "../testing/jsdom-env.ts";

// Heads-down entry in the line grid: lists open on Enter and advance on a
// choice, Tab starts the next line, F8 repeats a value, arrows move between
// lines, and a spreadsheet block pastes into rows and columns.
await bootJsdomEnvironment({ url: "http://localhost:4800/ap/bills", matchMediaMatches: true });
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
const { EntryPreferencesProvider } = await import("../lib/entry-preferences-context");
const { DEFAULT_ENTRY_PREFERENCES } = await import("../lib/entry-preferences");
type LineGridColumn<Row extends Record<string, unknown>> =
  import("./line-grid").LineGridColumn<Row>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

interface Row extends Record<string, unknown> {
  clientKey: string;
  accountId: string;
  kind: string;
  description: string;
  amount: string;
}

let keySeed = 0;
const blank = (): Row => ({
  clientKey: `k${++keySeed}`,
  accountId: "",
  kind: "",
  description: "",
  amount: "",
});
const store: { rows: Row[] } = { rows: [] };

const columns: LineGridColumn<Row>[] = [
  {
    key: "accountId",
    label: "Account",
    width: "200px",
    type: "search-select",
    options: [
      { value: "a1000", label: "1000 Operating Bank", keywords: ["1000"] },
      { value: "a2000", label: "2000 Accounts Payable", keywords: ["2000"] },
      { value: "a6000", label: "6000 Salaries", keywords: ["6000"] },
      { value: "a6100", label: "6100 Rent", keywords: ["6100"] },
      { value: "a6200", label: "6200 Utilities", keywords: ["6200"] },
      { value: "a6300", label: "6300 Office Supplies", keywords: ["6300"] },
      { value: "a6400", label: "6400 Insurance", keywords: ["6400"] },
      { value: "a6800", label: "6800 Software & Subscriptions", keywords: ["6800"] },
    ],
  },
  {
    key: "kind",
    label: "Kind",
    width: "120px",
    type: "select",
    options: [
      { value: "", label: "—" },
      { value: "goods", label: "Goods" },
      { value: "services", label: "Services" },
    ],
  },
  { key: "description", label: "Description", width: "160px", type: "text" },
  { key: "amount", label: "Amount", width: "120px", type: "amount", align: "right" },
];

function Probe({
  initial,
  autoDecimal,
  gridColumns,
}: {
  initial: Row[];
  autoDecimal: boolean;
  gridColumns: LineGridColumn<Row>[];
}) {
  const [rows, setRows] = useState(initial);
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <EntryPreferencesProvider initial={{ ...DEFAULT_ENTRY_PREFERENCES, autoDecimal }}>
        <div role="dialog">
          <LineGrid<Row>
            columns={gridColumns}
            rows={rows}
            onRowsChange={(next) => {
              store.rows = next;
              setRows(next);
            }}
            emptyRow={blank}
            getRowKey={(row) => row.clientKey}
            cloneRow={(row) => ({ ...row, clientKey: `k${++keySeed}` })}
          />
          <button type="button">After grid</button>
        </div>
      </EntryPreferencesProvider>
    </NextIntlClientProvider>
  );
}

async function mount(initial: Row[], autoDecimal = false, gridColumns = columns) {
  store.rows = initial;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe initial={initial} autoDecimal={autoDecimal} gridColumns={gridColumns} />);
    await tick();
  });
  await tick();
  return {
    host,
    async done() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const cell = (host: Element, row: number, col: number) => {
  const element = host.querySelector(`[data-lg-row="${row}"][data-lg-col="${col}"]`);
  assert.ok(element, `row ${row} col ${col} renders`);
  return element as HTMLElement;
};
const control = (host: Element, row: number, col: number) =>
  cell(host, row, col).querySelector("input, button") as HTMLElement;
async function key(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
    await tick();
  });
  // Focus moves on the next animation frame; give it two.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await tick();
  });
}
async function typeText(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

test("Enter on a closed list opens it, and choosing advances to the next cell without adding a line", async (t) => {
  const { host, done } = await mount([blank()]);
  t.after(done);
  const trigger = control(host, 0, 0);
  trigger.focus();
  await key(trigger, { key: "Enter" });
  assert.equal(store.rows.length, 1, "Enter opened the list instead of adding a line");
  const search = document.activeElement as HTMLInputElement;
  assert.equal(search.getAttribute("aria-label"), "Search…", "the search box holds focus");
  await typeText(search, "68");
  await key(search, { key: "Enter" });
  assert.equal(store.rows[0]!.accountId, "a6800", "the code typed chose its account");
  assert.equal(store.rows.length, 1, "choosing never adds a line");
  assert.ok(document.activeElement === control(host, 0, 1), "focus moved on to the next cell");
});

test("typing on a closed list opens it already searching", async (t) => {
  const { host, done } = await mount([blank()]);
  t.after(done);
  const trigger = control(host, 0, 0);
  trigger.focus();
  await key(trigger, { key: "6" });
  const search = document.activeElement as HTMLInputElement;
  assert.equal(search.value, "6", "the typed key is the query");
  await key(search, { key: "Escape" });
  assert.ok(document.activeElement === trigger, "Escape returns focus to the cell");
  assert.equal(store.rows[0]!.accountId, "", "Escape chooses nothing");
});

test("Tab past the last cell of a filled last line starts a new line; an empty last line lets Tab leave", async (t) => {
  const { host, done } = await mount([{ ...blank(), accountId: "a6300", amount: "10.0000" }]);
  t.after(done);
  const amount = control(host, 0, 3);
  amount.focus();
  await key(amount, { key: "Tab" });
  assert.equal(store.rows.length, 2, "a new line was started");
  assert.equal(
    document.activeElement,
    control(host, 1, 0),
    "focus is on the new line's first cell",
  );
  const nextAmount = control(host, 1, 3);
  nextAmount.focus();
  const event = new window.KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    nextAmount.dispatchEvent(event);
    await tick();
  });
  assert.equal(event.defaultPrevented, false, "Tab from an empty last line is left to the browser");
  assert.equal(store.rows.length, 2);
});

test("F8 copies the field from the line above and arrows move between lines", async (t) => {
  const { host, done } = await mount([{ ...blank(), description: "Printer paper" }, blank()]);
  t.after(done);
  const below = control(host, 1, 2);
  below.focus();
  await key(below, { key: "F8" });
  assert.equal(store.rows[1]!.description, "Printer paper");
  await key(control(host, 1, 2), { key: "ArrowUp" });
  assert.ok(
    document.activeElement === control(host, 0, 2),
    "ArrowUp moved to the same column on the line above",
  );
  await key(control(host, 0, 2), { key: "ArrowDown" });
  assert.ok(document.activeElement === control(host, 1, 2));
});

test("Alt+Enter inserts a line below and Alt+Shift+Enter above", async (t) => {
  const { host, done } = await mount([{ ...blank(), description: "first" }]);
  t.after(done);
  await key(control(host, 0, 2), { key: "Enter", altKey: true });
  assert.deepEqual(
    store.rows.map((row) => row.description),
    ["first", ""],
  );
  await key(control(host, 0, 2), { key: "Enter", altKey: true, shiftKey: true });
  assert.deepEqual(
    store.rows.map((row) => row.description),
    ["", "first", ""],
  );
});

test("amount cells take arithmetic and publish the exact result", async (t) => {
  const { host, done } = await mount([blank()]);
  t.after(done);
  const amount = control(host, 0, 3) as HTMLInputElement;
  amount.focus();
  await typeText(amount, "200+47.83");
  assert.equal(store.rows[0]!.amount, "247.8300");
  await act(async () => {
    amount.blur();
    await tick();
  });
  assert.equal(amount.value, "247.83", "the settled amount shows at currency precision");
});

test("a spreadsheet block with a header row pastes by column name, resolving codes and flagging what it cannot read", async (t) => {
  const { host, done } = await mount([blank()]);
  t.after(done);
  const trigger = control(host, 0, 0);
  trigger.focus();
  const text =
    "Account\tDescription\tAmount\n6300\tPrinter paper\t$1,234.50\n6800 Software\tLicences\t52.99\nNo such account\tPens\t(12.00)\n";
  const paste = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  await act(async () => {
    trigger.dispatchEvent(paste);
    await tick();
  });
  assert.equal(store.rows.length, 3);
  assert.deepEqual(
    store.rows.map((row) => [row.accountId, row.description, row.amount]),
    [
      ["a6300", "Printer paper", "1234.5000"],
      ["a6800", "Licences", "52.9900"],
      ["", "Pens", "-12.0000"],
    ],
  );
  assert.match(host.textContent ?? "", /1 pasted value needs attention/);
  assert.match(cell(host, 2, 0).getAttribute("title") ?? "", /No such account/);
});

test("short lists without a search box jump to the option typed and choose it with Enter", async (t) => {
  const { host, done } = await mount([blank()]);
  t.after(done);
  const kind = control(host, 0, 1);
  kind.focus();
  await key(kind, { key: "s" });
  assert.equal(kind.getAttribute("aria-expanded"), "true", "typing opened the list");
  await key(kind, { key: "Enter" });
  assert.equal(store.rows[0]!.kind, "services");
  assert.ok(document.activeElement === control(host, 0, 2), "the choice advanced to the next cell");
});

test("copy above into a focused amount survives refocus, blur and later row edits", async (t) => {
  const { host, done } = await mount([{ ...blank(), amount: "250.0000" }, blank()]);
  t.after(done);
  const below = control(host, 1, 3) as HTMLInputElement;
  await act(async () => {
    below.focus();
    await tick();
  });
  await key(below, { key: "F8" });
  assert.equal(below.value, "250.00");
  await act(async () => {
    below.blur();
    await tick();
  });
  assert.equal(store.rows[1]!.amount, "250.0000");
  await key(control(host, 1, 2), { key: "Enter", altKey: true });
  assert.equal(store.rows[1]!.amount, "250.0000");
});

test("single-value money paste settles exactly and refuses excess precision", async (t) => {
  const { host, done } = await mount([blank()], true);
  t.after(done);
  const amount = control(host, 0, 3) as HTMLInputElement;
  await act(async () => {
    amount.focus();
    await tick();
  });
  const paste = async (text: string) => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
    await act(async () => {
      amount.dispatchEvent(event);
      await tick();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.equal(event.defaultPrevented, true);
  };
  await paste("1785");
  assert.equal(store.rows[0]!.amount, "1785.0000");
  await act(async () => {
    amount.blur();
    await tick();
  });
  assert.equal(store.rows[0]!.amount, "1785.0000");
  await paste("12.34567");
  assert.equal(
    store.rows[0]!.amount,
    "1785.0000",
    "invalid paste preserves the prior amount and flags the cell",
  );
  assert.match(host.textContent ?? "", /1 pasted value needs attention/);
});

test("decimal block paste preserves eight places instead of rounding to money scale", async (t) => {
  const { host, done } = await mount([blank()], false, [
    { key: "quantity", label: "Quantity", type: "decimal", decimalScale: 8, width: "150px" },
  ]);
  t.after(done);
  const input = control(host, 0, 0);
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "Quantity\n1.23456789\n2.12345678" },
  });
  await act(async () => {
    input.dispatchEvent(event);
    await tick();
  });
  assert.deepEqual(
    store.rows.map((row) => row.quantity),
    ["1.23456789", "2.12345678"],
  );
});

test("copy above commits focused decimal and date cells before replacing their drafts", async (t) => {
  const { host, done } = await mount(
    [{ ...blank(), quantity: "1.23456789", date: "2026-10-12" }, blank()],
    false,
    [
      { key: "quantity", label: "Quantity", type: "decimal", decimalScale: 8, width: "150px" },
      { key: "date", label: "Date", type: "date", width: "150px" },
    ],
  );
  t.after(done);
  for (const [col, field, expected] of [
    [0, "quantity", "1.23456789"],
    [1, "date", "2026-10-12"],
  ] as const) {
    const input = control(host, 1, col) as HTMLInputElement;
    await act(async () => {
      input.focus();
      await tick();
    });
    await key(input, { key: "F8" });
    await act(async () => {
      input.blur();
      await tick();
    });
    assert.equal(store.rows[1]![field], expected);
  }
});

test("an oversized spreadsheet paste is refused as a whole instead of truncating financial lines", async (t) => {
  const { host, done } = await mount([blank()]);
  t.after(done);
  const input = control(host, 0, 0);
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: () => Array.from({ length: 501 }, () => "6300\tgoods\tPaper\t10.00").join("\n"),
    },
  });
  await act(async () => {
    input.dispatchEvent(event);
    await tick();
  });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]!.amount, "");
  assert.match(host.textContent ?? "", /Paste at most 500 rows/);
});

test("a full-width spreadsheet paste preserves positions across computed columns", async (t) => {
  const { host, done } = await mount([blank()], false, [
    { key: "description", label: "Description", type: "text", width: "150px" },
    { key: "computed", label: "Computed", type: "readonly", width: "150px" },
    { key: "amount", label: "Amount", type: "amount", width: "150px" },
  ]);
  t.after(done);
  const input = control(host, 0, 0);
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "Paper\t99.00\t10.00" },
  });
  await act(async () => {
    input.dispatchEvent(event);
    await tick();
  });
  assert.equal(store.rows[0]!.description, "Paper");
  assert.equal(store.rows[0]!.amount, "10.0000");
  assert.match(host.textContent ?? "", /1 pasted value needs attention/);
});
