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
const { rowsRenderInBrowser, WINDOWED_ROWS_FROM } = await import("./windowed-rows");

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
    rows: Array.from({ length: count }, (_, i) => ({ key: `r${i}`, name: `Customer ${String(i).padStart(4, "0")}`, partyId: `p${i}`, href: `/s/${i}` })),
    placeholder: "—",
  };
}

const nameCell = { kind: "text", field: { $: "name" } };
const partyCell = { kind: "widget", widget: "party-link-cell", props: { partyId: { $: "partyId" }, partyName: { $: "name" }, href: { $: "href" } } };

function render(block: Block, count: number): string {
  return renderToStaticMarkup(<BlockView block={block} scope={scopeWith(count)} searchParams={{}} />);
}

test("long report tables send only the first window of rows as markup", () => {
  const count = WINDOWED_ROWS_FROM + 700;
  const html = render(reportTable(count, [partyCell, nameCell]), count);
  assert.match(html, /Customer 0000/);
  assert.match(html, /Customer 0059/, "the first window renders on the server");
  assert.doesNotMatch(html, /Customer 0060/, "rows past the first window render in the browser");
  assert.match(html, new RegExp(`height:${(count - 60) * 33}px`), "a spacer keeps the full table height");
});

test("short tables and tables needing the page scope render every row on the server", () => {
  const short = render(reportTable(WINDOWED_ROWS_FROM, [nameCell]), WINDOWED_ROWS_FROM);
  assert.match(short, new RegExp(`Customer ${String(WINDOWED_ROWS_FROM - 1).padStart(4, "0")}`));

  const count = WINDOWED_ROWS_FROM + 50;
  const rooted = reportTable(count, [nameCell, { kind: "text", field: { $: "$root.placeholder" } }]);
  assert.equal(rowsRenderInBrowser(rooted as never), false);
  assert.match(render(rooted, count), new RegExp(`Customer ${String(count - 1).padStart(4, "0")}`));

  const serverWidget = reportTable(count, [{ kind: "widget", widget: "statement-rows", props: {} }]);
  assert.equal(rowsRenderInBrowser(serverWidget as never), false, "widgets only the server registry renders keep the table on the server");
});
