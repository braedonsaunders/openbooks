import assert from "node:assert/strict";
import test from "node:test";
import type { StatementPickerData } from "./view";

const { statementPickerSpec } = await import("./view");

// The hub's Customer statements entry opens a picker, not a statement: each
// customer row must link to that customer's statement for the picker's
// period, and an empty customer list must explain itself instead of showing
// a bare table. The loader (period → row hrefs) needs a database; this pins
// the spec half — whatever rows the loader resolved, the name cell links
// exactly their hrefs, and the empty state carries the loader's copy.
function stubData(rows: StatementPickerData["rows"]): StatementPickerData {
  return {
    title: "Customer statements",
    primaryFilter: null,
    sendHref: "/reports/statements/send",
    sendLabel: "Send statements",
    canSend: false,
    backHref: "/reports",
    backLabel: "Reports",
    searchPlaceholder: "Search customer…",
    columnCustomer: "Customer",
    columnBalance: "Outstanding",
    company: "Acme",
    periodPhrase: "Jan 2026",
    dateRange: { from: "2026-01-01", to: "2026-01-31" },
    rows,
    totalRows: rows.length,
    currentPage: 1,
    perPage: 50,
    emptyTitle: "No customers with balances",
    emptyHint: "Post a receivable invoice to open a statement.",
    hasRows: rows.length > 0,
    subsidiaries: [],
    currencyBasisBlocked: null,
    currencyBasisReady: true,
  };
}

function walkBlocks(
  node: unknown,
  kind: string,
): {
  kind: string;
  title?: string;
  columns?: {
    header: unknown;
    cell: { kind: string; label?: { $: string }; href?: { $: string } };
  }[];
}[] {
  const found: {
    kind: string;
    title?: string;
    columns?: {
      header: unknown;
      cell: { kind: string; label?: { $: string }; href?: { $: string } };
    }[];
  }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.kind === kind) found.push(record as { kind: string });
      for (const child of Object.values(record)) visit(child);
    }
  };
  visit(node);
  return found;
}

function tableBlock(spec: ReturnType<typeof statementPickerSpec>) {
  const tables = walkBlocks(JSON.parse(JSON.stringify(spec)), "table");
  assert.equal(tables.length, 1, "the picker renders exactly one table");
  return tables[0]!;
}

test("each customer row links its name to that customer statement", () => {
  const spec = statementPickerSpec(
    stubData([
      {
        rowKey: "c1",
        displayName: "Maple Foods",
        balance: "1,240.00",
        balanceTone: "default",
        href: "/reports/statements/c1?period=custom&from=2026-01-01&to=2026-01-31",
      },
    ]),
  );
  const table = tableBlock(spec);
  assert.ok(table.columns, "the picker table must declare columns");
  assert.equal(table.columns.length, 2, "customer + outstanding, nothing else");
  const nameCell = table.columns[0]!.cell;
  assert.equal(nameCell.kind, "link", "the customer name is a link, not plain text");
  assert.ok(
    nameCell.href?.$.endsWith("href"),
    `the link must bind the row href (got ${nameCell.href?.$})`,
  );
  assert.equal(table.columns[1]!.cell.kind, "money", "the balance stays a money cell");
});

test("an empty customer list names the empty state instead of a bare table", () => {
  const spec = statementPickerSpec(stubData([]));
  const widgets = walkBlocks(JSON.parse(JSON.stringify(spec)), "widget") as {
    kind: string;
    widget: string;
    props?: { title?: string };
  }[];
  const empty = widgets.find((block) => block.widget === "empty-state");
  assert.ok(empty, "an empty picker must render an empty-state widget");
  assert.equal(empty.props?.title, "No customers with balances");
});
