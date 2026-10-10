// The shared drawer sublist: one heading row with the add action top right,
// a full-width search toolbar, the table, then count and pager.
import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env";

await bootJsdomEnvironment({ url: "http://localhost:4800/parties", matchMediaMatches: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../messages/en")).default as Record<string, unknown>;
const { DrawerSublist, SublistAddButton, SublistEmpty, SublistPager, useSublistRows } = await import("./drawer-sublist");

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function render(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">{node}</NextIntlClientProvider>);
    await tick();
  });
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function classes(element: Element | null): string[] {
  return (element?.getAttribute("class") ?? "").split(/\s+/);
}

const ROWS = Array.from({ length: 23 }, (_, index) => ({ id: `row-${index + 1}`, name: index % 2 ? `Odd ${index + 1}` : `Even ${index + 1}` }));

function Harness() {
  const list = useSublistRows(ROWS, (row) => row.name);
  return (
    <DrawerSublist
      title="Things"
      description="A deliberately long description that would once push the add action under the heading on a narrow drawer."
      action={<SublistAddButton label="Add thing" onClick={() => {}} />}
      search={{ value: list.query, onChange: list.setQuery, placeholder: "Search things" }}
      filters={<select aria-label="Status"><option>All</option></select>}
      footer={<SublistPager count={`${list.filtered.length} things`} page={list.page} pages={list.pages} onPage={list.setPage} />}
    >
      <table><tbody>{list.shown.map((row) => <tr key={row.id}><td>{row.name}</td></tr>)}</tbody></table>
    </DrawerSublist>
  );
}

test("the add action is the trailing element of a non-wrapping header row", async (t) => {
  const view = await render(<Harness />);
  t.after(view.done);
  const section = view.host.querySelector("[data-drawer-sublist]")!;
  const header = section.firstElementChild!;
  assert.ok(header.querySelector("h3")?.textContent?.includes("Things"), "the heading leads the header row");
  const action = header.querySelector("[data-sublist-action]");
  assert.equal(header.lastElementChild, action, "the action is pinned at the end of the header row");
  assert.ok(classes(header).includes("justify-between"), "heading and action sit at opposite ends");
  assert.ok(!classes(header).includes("flex-wrap"), "a long description never wraps the action below the heading");
  assert.ok(classes(action).includes("shrink-0"), "the action keeps its width");
  assert.ok(classes(header.firstElementChild).includes("flex-1"), "the heading takes the remaining width");
});

test("search stretches across the toolbar with filters beside it, ahead of the table", async (t) => {
  const view = await render(<Harness />);
  t.after(view.done);
  const section = view.host.querySelector("[data-drawer-sublist]")!;
  const toolbar = section.querySelector("[data-sublist-toolbar]")!;
  assert.ok(classes(toolbar).includes("w-full"), "the toolbar spans the drawer");
  const search = toolbar.querySelector("[data-sublist-search]")!;
  assert.ok(classes(search).includes("flex-1"), "the search grows to fill the toolbar");
  assert.ok(!classes(search).some((name) => name.startsWith("max-w") || name.startsWith("sm:w-")), "the search is never capped");
  assert.ok(classes(search.querySelector("input")).includes("w-full"));
  assert.equal(search.querySelector("input")?.getAttribute("aria-label"), "Search things");
  assert.ok(toolbar.querySelector('select[aria-label="Status"]'), "filters share the search row");
  const order = [...section.children];
  assert.ok(order.indexOf(toolbar) < order.indexOf(section.querySelector("table")!), "the toolbar precedes the table");
});

test("client rows search and page, and a new query restarts at the first page", async (t) => {
  const view = await render(<Harness />);
  t.after(view.done);
  assert.equal(view.host.querySelectorAll("tbody tr").length, 10, "ten rows per page");
  assert.match(view.host.textContent ?? "", /1 \/ 3/);
  const next = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Next")!;
  await act(async () => {
    next.click();
    await tick();
  });
  assert.match(view.host.textContent ?? "", /2 \/ 3/);
  const input = view.host.querySelector("[data-sublist-search] input") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, "odd");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
  assert.match(view.host.textContent ?? "", /11 things/, "the search matches case-insensitively");
  assert.match(view.host.textContent ?? "", /1 \/ 2/, "the query restarts paging");
});

test("an empty list names its remedy and carries the action that performs it", async (t) => {
  let clicks = 0;
  const view = await render(
    <SublistEmpty text="Add a thing first" hint="Things power the other things." action={<SublistAddButton label="Add thing" onClick={() => { clicks += 1; }} />} />,
  );
  t.after(view.done);
  const empty = view.host.querySelector("[data-sublist-empty]")!;
  assert.equal(empty.querySelector('[role="alert"]'), null, "an empty state is not an error");
  assert.ok(empty.textContent?.includes("Add a thing first"));
  assert.ok(empty.textContent?.includes("Things power the other things."));
  await act(async () => {
    (empty.querySelector("button") as HTMLButtonElement).click();
    await tick();
  });
  assert.equal(clicks, 1);
});
