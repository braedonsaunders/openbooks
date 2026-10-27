import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Block } from "@braedonsaunders/appkit-viewspec";

registerHooks({
  resolve(specifier, context, next) {
    if (/\.(css|scss|sass|less)(\?[^"]*)?$/.test(specifier)) {
      return { url: "data:text/javascript,export default {}", shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { BlockView } = await import("./blocks");
const { pickScope, rowsRenderInBrowser, WINDOWED_ROWS_FROM } = await import("./windowed-rows");
const { PathnameContext, SearchParamsContext } =
  await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { prerenderToNodeStream } = await import("react-dom/static");

function reportTable(rows: number, cells: Record<string, unknown>[]): Block {
  return {
    kind: "table",
    variant: "report",
    rows: { $: "rows" },
    rowKey: { $: "key" },
    columns: cells.map((cell) => ({ header: "", cell })),
  } as unknown as Block;
}

function scopeWith(count: number) {
  return {
    rows: Array.from({ length: count }, (_, i) => ({
      key: `r${i}`,
      name: `Customer ${String(i).padStart(4, "0")}`,
      partyId: `p${i}`,
      href: `/s/${i}`,
    })),
    placeholder: "—",
  };
}

const nameCell = { kind: "text", field: { $: "name" } };
const partyCell = {
  kind: "widget",
  widget: "party-link-cell",
  props: { partyId: { $: "partyId" }, partyName: { $: "name" }, href: { $: "href" } },
};

function render(block: Block, count: number): string {
  return renderToStaticMarkup(
    <BlockView block={block} scope={scopeWith(count)} searchParams={{}} />,
  );
}

test("long report tables send only the first window of rows as markup", () => {
  const count = WINDOWED_ROWS_FROM + 700;
  const html = render(reportTable(count, [partyCell, nameCell]), count);
  assert.match(html, /Customer 0000/);
  assert.match(html, /Customer 0059/, "the first window renders on the server");
  assert.doesNotMatch(html, /Customer 0060/, "rows past the first window render in the browser");
  assert.match(
    html,
    new RegExp(`height:${(count - 60) * 33}px`),
    "a spacer keeps the full table height",
  );
});

test("short tables and tables needing the page scope render every row on the server", () => {
  const short = render(reportTable(WINDOWED_ROWS_FROM, [nameCell]), WINDOWED_ROWS_FROM);
  assert.match(short, new RegExp(`Customer ${String(WINDOWED_ROWS_FROM - 1).padStart(4, "0")}`));

  const count = WINDOWED_ROWS_FROM + 50;
  const rooted = reportTable(count, [
    nameCell,
    { kind: "text", field: { $: "$root.placeholder" } },
  ]);
  assert.equal(rowsRenderInBrowser(rooted as never), false);
  assert.match(render(rooted, count), new RegExp(`Customer ${String(count - 1).padStart(4, "0")}`));

  const serverWidget = reportTable(count, [
    { kind: "widget", widget: "statement-rows", props: {} },
  ]);
  assert.equal(
    rowsRenderInBrowser(serverWidget as never),
    false,
    "widgets only the server registry renders keep the table on the server",
  );
});

/** Drill links read the current address, which a Next request provides. */
function renderInRequest(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <PathnameContext.Provider value="/reports/registers">
      <SearchParamsContext.Provider value={new URLSearchParams() as never}>
        {node}
      </SearchParamsContext.Provider>
    </PathnameContext.Provider>,
  );
}

test("a section ships only the paths its headings and span rows read", () => {
  const scope = {
    name: "Acme",
    closing: "$10.00",
    lines: [{ key: "a" }],
    secret: "not read",
    $root: { closingLabel: "Closing", columns: ["unused"] },
  };
  const specs = [
    { partyName: { $: "name" }, closingLabel: { $: "$root.closingLabel" } },
    [{ $: "closing" }, { $: "missing" }],
  ];
  assert.deepEqual(pickScope(specs, scope), {
    name: "Acme",
    closing: "$10.00",
    $root: { closingLabel: "Closing" },
  });
});

function groupedReport(): Block {
  return {
    kind: "repeat",
    items: { $: "parties" },
    itemKey: { $: "key" },
    className: "space-y-8",
    blocks: [
      {
        kind: "widget",
        widget: "party-heading",
        props: {
          partyId: { $: "partyId" },
          partyName: { $: "name" },
          statementHref: { $: "href" },
          closingLabel: { $: "$root.closingLabel" },
          closing: { $: "closing" },
        },
      },
      {
        kind: "table",
        variant: "report",
        rows: { $: "lines" },
        rowKey: { $: "key" },
        columns: [
          { header: { $: "$root.columnMemo" }, cell: { kind: "text", field: { $: "memo" } } },
        ],
      },
    ],
  } as unknown as Block;
}

function partiesScope(parties: number, linesEach: number) {
  return {
    closingLabel: "Closing balance",
    columnMemo: "Memo",
    parties: Array.from({ length: parties }, (_, p) => ({
      key: `p${p}`,
      partyId: `p${p}`,
      name: `Party ${String(p).padStart(3, "0")}`,
      href: `/s/${p}`,
      closing: "$1.00",
      lines: Array.from({ length: linesEach }, (_, l) => ({
        key: `p${p}-l${l}`,
        memo: `Line ${p}-${l}`,
      })),
    })),
  };
}

test("long grouped reports send only the first sections as markup", () => {
  const html = renderInRequest(
    <BlockView block={groupedReport()} scope={partiesScope(40, 20)} searchParams={{}} />,
  );
  assert.match(html, /Party 000/);
  assert.match(html, /Party 002/, "sections up to the first window render on the server");
  assert.doesNotMatch(html, /Party 010/, "later sections render in the browser");
  assert.match(html, /Closing balance/, "page labels a section reads reach it");
  assert.match(html, /<th[^>]*>Memo<\/th>/);
});

test("short grouped reports render every section on the server", async () => {
  // The server path loads widget families on use, so it renders with suspense.
  const { prelude } = await prerenderToNodeStream(
    <PathnameContext.Provider value="/reports/registers">
      <SearchParamsContext.Provider value={new URLSearchParams() as never}>
        <BlockView block={groupedReport()} scope={partiesScope(10, 20)} searchParams={{}} />
      </SearchParamsContext.Provider>
    </PathnameContext.Provider>,
  );
  let html = "";
  for await (const chunk of prelude) html += chunk;
  assert.match(html, /Party 009/);
});
