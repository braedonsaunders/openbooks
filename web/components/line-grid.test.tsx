import assert from "node:assert/strict";
import test from "node:test";

// LineGrid reorder/delete must never land one line's uncommitted edit on
// another line: DecimalCell/TaxCell keep a focus draft and commit on blur,
// while Alt+Up/Down and Ctrl+Backspace reorder the rows underneath the
// still-focused input. Real component coverage (only i18n is real data):
// mount the grid, type into a line, reorder/remove, blur, and read back
// which line received the commit.

// jsdom first: the grid reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ap/bills",
  // @types/jsdom lags the runtime here: pretendToBeVisual enables rAF.
  pretendToBeVisual: true,
} as unknown as { url: string });
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "KeyboardEvent", "FocusEvent", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0)) as unknown as typeof requestAnimationFrame;
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export function useRouter(){return globalThis.__drawerRouter}export function usePathname(){return '/ap/bills'}export function useSearchParams(){return new URLSearchParams()}",
      };
    }
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){},warning(){}};export function Toaster(){return null}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
}

const store: { rows: TestRow[] } = { rows: [] };

function Probe({ initial }: { initial: TestRow[] }) {
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
  ];
  return (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <LineGrid<TestRow>
        columns={columns}
        rows={rows}
        onRowsChange={(next) => apply(next)}
        emptyRow={() => ({ clientKey: `new-${Date.now()}`, description: "", quantity: "", taxAmount: "", taxOverridden: false })}
      />
    </NextIntlClientProvider>
  );
}

async function mount(initial: TestRow[]) {
  store.rows = initial;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe initial={initial} />);
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

async function keydown(el: Element, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    await tick();
  });
  await tick();
}

async function blur(el: HTMLInputElement) {
  await act(async () => {
    el.blur();
    await tick();
  });
  await tick();
}

const line = (key: string, quantity: string): TestRow => ({
  clientKey: key,
  description: `line ${key}`,
  quantity,
  taxAmount: "",
  taxOverridden: false,
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
