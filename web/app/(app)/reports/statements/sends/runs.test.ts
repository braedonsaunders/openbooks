import assert from "node:assert/strict";
import test from "node:test";
import type { StatementBatchRunsData } from "./view";

const { statementBatchRunsSpec } = await import("./view");

// The batch history lists every run with its tallies; a selected run
// opens its detail drawer beside the list instead of navigating away.
function stubData(selectedRunId: string | null): StatementBatchRunsData {
  return {
    title: "Statement batches",
    backHref: "/reports/statements",
    backLabel: "Customer statements",
    company: "Acme",
    periodPhrase: "Balances as of today",
    columnCreated: "Created",
    columnPeriod: "Period",
    columnRecipients: "Recipients",
    columnSent: "Sent",
    columnFailed: "Failed",
    columnSkipped: "Skipped",
    columnStatus: "Status",
    rows: [
      {
        rowKey: "run-1",
        created: "2026-10-01 09:00",
        period: "2026-10-01",
        recipients: "3",
        sent: "2",
        failed: "1",
        failedTone: "negative",
        skipped: "0",
        status: "Sending",
        href: "/reports/statements/sends?run=run-1",
      },
    ],
    hasRows: true,
    emptyTitle: "No statement batches yet",
    emptyHint: "Send statements first.",
    selectedRunId,
  };
}

function widgetsOf(spec: unknown, name: string): { props?: Record<string, unknown> }[] {
  const found: { props?: Record<string, unknown> }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      const node = value as { widget?: string; props?: Record<string, unknown> };
      if (node.widget === name) found.push({ props: node.props });
      for (const entry of Object.values(node)) visit(entry);
    }
  };
  visit(spec);
  return found;
}

type TableBlock = { kind: string; columns?: { cell: { kind: string; href?: { $: string } } }[] };

function tablesOf(spec: unknown): TableBlock[] {
  const found: TableBlock[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      const node = value as TableBlock;
      if (node.kind === "table") found.push(node);
      for (const entry of Object.values(node)) visit(entry);
    }
  };
  visit(JSON.parse(JSON.stringify(spec)));
  return found;
}

test("run rows link the detail drawer and the drawer opens the selection", () => {
  const tables = tablesOf(statementBatchRunsSpec(stubData("run-1")));
  assert.equal(tables.length, 1);
  const createdCell = tables[0]!.columns![0]!.cell;
  assert.equal(createdCell.kind, "link");
  assert.ok(
    createdCell.href?.$.endsWith("href"),
    `run rows link the drawer (got ${createdCell.href?.$})`,
  );
  const [drawer] = widgetsOf(
    statementBatchRunsSpec(stubData("run-1")) as never,
    "statement-batch-run-drawer",
  );
  assert.ok(drawer);
  assert.equal(drawer!.props?.runId, "run-1");
});

test("no drawer opens without a selection", () => {
  const [drawer] = widgetsOf(
    statementBatchRunsSpec(stubData(null)) as never,
    "statement-batch-run-drawer",
  );
  assert.ok(drawer);
  assert.equal(drawer!.props?.runId, null);
});
