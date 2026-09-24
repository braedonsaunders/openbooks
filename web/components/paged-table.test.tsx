import assert from "node:assert/strict";
import test from "node:test";

// jsdom first: the table reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/ar/invoices",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default;
const { PagedTable } = await import("./paged-table");

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

interface Row {
  id: string;
  name: string;
}

const opened: string[] = [];
const acted: string[] = [];
const toggled: string[] = [];

async function mountTable() {
  opened.length = 0;
  acted.length = 0;
  toggled.length = 0;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PagedTable<Row>
          rows={[
            { id: "a", name: "Alpha" },
            { id: "b", name: "Beta" },
          ]}
          columns={[
            {
              key: "name",
              header: "Name",
              cell: (row) => <span data-testid={`cell-${row.id}`}>{row.name}</span>,
            },
            {
              key: "act",
              header: "Act",
              cell: (row) => (
                <button type="button" data-testid={`act-${row.id}`} onClick={() => acted.push(row.id)}>
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
    );
    await tick();
  });
  await tick();
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await tick();
  });
  await tick();
}

function rowActionButton(id: string): HTMLButtonElement {
  const el = document.querySelector(`[data-testid="act-${id}"]`);
  assert.ok(el, `action button for row ${id} renders`);
  return el as HTMLButtonElement;
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

test("plain cells open the row and focused rows support keyboard activation", async () => {
  const table = await mountTable();
  try {
    const cell = document.querySelector('[data-testid="cell-b"]') as HTMLElement;
    const row = cell.closest("tr");
    assert.ok(row);
    await click(row);
    assert.deepEqual(opened, ["b"]);
    assert.equal(row.getAttribute("tabindex"), "0");
    row.focus();
    await act(async () => row.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(opened, ["b", "b"]);
  } finally {
    await table.unmount();
  }
});

test("the selection checkbox toggles without opening the row", async () => {
  const table = await mountTable();
  try {
    const checkbox = document.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
    await click(checkbox);
    assert.deepEqual(toggled, ["a"]);
    assert.deepEqual(opened, [], "selecting a row must not open it");
  } finally {
    await table.unmount();
  }
});

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
