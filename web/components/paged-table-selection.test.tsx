import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import type { PagedColumn, PagedSelection } from "./paged-table";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/assets",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function () {};
}
if (typeof dom.window.requestAnimationFrame !== "function") {
  dom.window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof window.requestAnimationFrame;
  dom.window.cancelAnimationFrame = ((id: number) =>
    clearTimeout(id)) as unknown as typeof window.cancelAnimationFrame;
}
if (globals.requestAnimationFrame === undefined) {
  globals.requestAnimationFrame = dom.window.requestAnimationFrame;
  globals.cancelAnimationFrame = dom.window.cancelAnimationFrame;
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: false,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const { registerHooks } = await import("node:module");
const { pathToFileURL } = await import("node:url");
// @openbooks/* symlinks resolve to the MAIN checkout (stale); pin the real
// worktree copy so the test runs the code under test.
const worktreeUi = pathToFileURL(
  (await import("node:path")).join(process.cwd(), "packages", "ui", "src", "index.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/ui") {
      return { shortCircuit: true, url: worktreeUi };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { PagedTable } = await import("./paged-table");

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `id-${i + 1}`,
  name: `Asset ${i + 1}`,
}));

const COLUMNS = [
  {
    key: "name",
    header: "Name",
    cell: (row: Row) => row.name,
    search: (row: Row) => `${row.id} ${row.name}`,
  },
];

type TableProps = {
  rows: Row[];
  columns: PagedColumn<Row>[];
  rowKey: (row: Row) => string;
  empty: string;
  searchable: boolean;
  pageSize: number;
  selection?: PagedSelection<Row>;
  onRowClick?: (row: Row) => void;
};

function renderTable(props: {
  rows?: Row[];
  selectedIds?: string[];
  onToggle?: (id: string) => void;
  onToggleAll?: (ids: string[]) => void;
  disabled?: boolean;
  withSelection?: boolean;
  onRowClick?: (row: Row) => void;
}) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const tableProps: TableProps = {
    rows: props.rows ?? ROWS,
    columns: COLUMNS,
    rowKey: (row: Row) => row.id,
    empty: "none",
    searchable: true,
    pageSize: 10,
  };
  if (props.withSelection !== false) {
    tableProps.selection = {
      getId: (row: Row) => row.id,
      selectedIds: props.selectedIds ?? [],
      onToggle: props.onToggle ?? (() => {}),
      onToggleAll: props.onToggleAll ?? (() => {}),
      disabled: props.disabled,
    };
  }
  if (props.onRowClick) tableProps.onRowClick = props.onRowClick;
  return { host, root, tableProps };
}

const TypedTable = PagedTable as unknown as (props: TableProps) => ReactElement;
// The installed React types require `children` inside the props object while
// eslint forbids children-as-props; a loose provider alias satisfies both.
const TypedIntlProvider = NextIntlClientProvider as unknown as (
  props: Record<string, unknown>,
) => ReactElement;

async function mount(props: Parameters<typeof renderTable>[0]) {
  const { host, root, tableProps } = renderTable(props);
  await act(async () => {
    root.render(
      React.createElement(
        TypedIntlProvider,
        {
          locale: "en",
          messages,
          timeZone: "UTC",
        },
        React.createElement(TypedTable, tableProps),
      ),
    );
  });
  return { host, root, tableProps };
}

function checkboxes() {
  return [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("paged-table: no selection prop renders no checkboxes (backward compatible)", async () => {
  const { root } = await mount({ withSelection: false });
  assert.equal(checkboxes().length, 0);
  // The data rows still render on the first page.
  assert.ok(document.body.textContent?.includes("Asset 1"));
  await act(async () => {
    root.unmount();
  });
});

test("paged-table: selection renders a header checkbox plus one per visible row", async () => {
  const { root } = await mount({ selectedIds: ["id-1"] });
  const boxes = checkboxes();
  // 12 rows at pageSize 10: header + 10 visible rows.
  assert.equal(boxes.length, 11);
  const [, firstRow] = boxes;
  assert.equal(firstRow?.checked, true);
  await act(async () => {
    root.unmount();
  });
});

test("paged-table: row toggle calls onToggle and never the row click", async () => {
  const toggled: string[] = [];
  let rowClicked = 0;
  const { root } = await mount({
    selectedIds: [],
    onToggle: (id) => void toggled.push(id),
    onRowClick: () => void (rowClicked += 1),
  });
  const [, firstRow] = checkboxes();
  await act(async () => {
    firstRow?.click();
  });
  assert.deepEqual(toggled, ["id-1"]);
  assert.equal(rowClicked, 0);
  await act(async () => {
    root.unmount();
  });
});

test("paged-table: select-all covers the filtered set across pages", async () => {
  const seen: string[][] = [];
  const { root } = await mount({ selectedIds: [], onToggleAll: (ids) => void seen.push(ids) });
  const [header] = checkboxes();
  assert.ok(header, "the header toggle must render");
  // The header toggle names its filtered-set semantics for screen readers —
  // never a hardcoded untranslated string.
  assert.equal(
    header.closest("th")?.querySelector(".sr-only")?.textContent,
    "Select all matching rows",
  );
  await act(async () => {
    header.click();
  });
  // No search: every row id, even the two past the first page.
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ROWS.map((row) => row.id));
  await act(async () => {
    root.unmount();
  });
});

test("paged-table: select-all after a search covers only the matching rows", async () => {
  const seen: string[][] = [];
  const { root, tableProps } = await mount({
    selectedIds: [],
    onToggleAll: (ids) => void seen.push(ids),
  });
  const search = document.querySelector('input[type="text"], input:not([type])') as HTMLInputElement | null;
  assert.ok(search, "the searchable table must render a search box");
  await act(async () => {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(search, "Asset 1");
    const DomEvent = (
      dom.window as unknown as { Event: new (type: string, init?: EventInit) => Event }
    ).Event;
    search.dispatchEvent(new DomEvent("input", { bubbles: true }));
  });
  // "Asset 1" matches Asset 1, 10, 11, 12.
  const [header, ...rows] = checkboxes();
  assert.ok(header, "the header toggle must render");
  assert.equal(rows.length, 4);
  await act(async () => {
    header.click();
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ["id-1", "id-10", "id-11", "id-12"]);
  assert.ok(tableProps, "table props retained");
  await act(async () => {
    root.unmount();
  });
});

test("paged-table: header checkbox tracks none/some/all via checked + indeterminate", async () => {
  const { root, tableProps } = await mount({ selectedIds: [] });
  await tick();
  let [header] = checkboxes();
  assert.ok(header, "the header toggle must render");
  assert.equal(header.checked, false);
  assert.equal(header.indeterminate, false);

  // Partial selection: unchecked but indeterminate.
  await act(async () => {
    root.render(
      React.createElement(
        TypedIntlProvider,
        {
          locale: "en",
          messages,
          timeZone: "UTC",
        },
        React.createElement(TypedTable, {
          ...tableProps,
          selection: {
            ...(tableProps.selection as PagedSelection<Row>),
            selectedIds: ["id-1"],
          },
        }),
      ),
    );
  });
  await tick();
  [header] = checkboxes();
  assert.ok(header, "the header toggle must render");
  assert.equal(header.checked, false);
  assert.equal(header.indeterminate, true);

  // Full filtered selection: checked, not indeterminate.
  await act(async () => {
    root.render(
      React.createElement(
        TypedIntlProvider,
        {
          locale: "en",
          messages,
          timeZone: "UTC",
        },
        React.createElement(TypedTable, {
          ...tableProps,
          selection: {
            ...(tableProps.selection as PagedSelection<Row>),
            selectedIds: ROWS.map((row) => row.id),
          },
        }),
      ),
    );
  });
  await tick();
  [header] = checkboxes();
  assert.ok(header, "the header toggle must render");
  assert.equal(header.checked, true);
  assert.equal(header.indeterminate, false);
  await act(async () => {
    root.unmount();
  });
});

test("paged-table: disabled selection disables every checkbox", async () => {
  const { root } = await mount({ selectedIds: [], disabled: true });
  const boxes = checkboxes();
  assert.ok(boxes.length > 0);
  assert.ok(boxes.every((box) => box.disabled));
  await act(async () => {
    root.unmount();
  });
});
