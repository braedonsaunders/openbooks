import assert from "node:assert/strict";
import test from "node:test";
import type { StatementBatchComposerData } from "./view";

const { statementBatchComposerSpec } = await import("./view");

// The composer previews exactly the run's audience: each recipient row
// links its statement for the previewed period, no-email customers list
// beside their fix link, and the send action carries the previewed
// filters — never a stale or empty body.
function stubData(): StatementBatchComposerData {
  return {
    title: "Send statements",
    backHref: "/reports/statements",
    backLabel: "Customer statements",
    company: "Acme",
    periodPhrase: "Jan 2026",
    dateRange: { from: "2026-01-01", to: "2026-01-31" },
    columnCustomer: "Customer",
    columnBalance: "Balance",
    columnOverdue: "Overdue",
    columnEmail: "Statement email",
    columnFix: "Add email",
    rows: [
      {
        rowKey: "party-1",
        displayName: "Acme",
        statementHref: "/reports/statements/party-1?period=custom&from=2026-01-01&to=2026-01-31",
        balance: "$100.00",
        balanceTone: "default",
        overdue: "$40.00",
        email: "ap@acme.test",
      },
    ],
    exclusions: [
      {
        rowKey: "party-2",
        displayName: "Silent",
        balance: "$50.00",
        fixHref: "/parties?party=party-2",
        fixLabel: "Add email",
      },
    ],
    summary: "1 ready to send · 1 without an email address",
    hasRows: true,
    hasExclusions: true,
    subsidiaries: [],
    primaryFilter: null,
    overdueAllHref: "/reports/statements/send",
    overdueOnlyHref: "/reports/statements/send?overdueOnly=1",
    overdueActive: false,
    overdueAllActive: true,
    overdueAllLabel: "All balances",
    overdueOnlyLabel: "Overdue only",
    emptyTitle: "No customers with balances",
    emptyHint: "Post a receivable invoice.",
    exclusionsTitle: "No email on file",
    send: {
      canCreate: true,
      notAllowed: "needs access",
      buttonLabel: "Send statements",
      sendingLabel: "Sending…",
      recipientCount: 1,
      viewBatchesHref: "/reports/statements/sends",
      viewBatchesLabel: "View batches",
      body: {
        from: "2026-01-01",
        toDate: "2026-01-31",
        overdueOnly: false,
        subsidiaryId: null,
        currency: null,
      },
    },
    currencyBasisBlocked: null,
    currencyBasisReady: true,
    periodInputError: null,
    periodInputBlocked: false,
  };
}

function widgetsOf(
  spec: { blocks?: unknown[]; header?: unknown[] },
  name: string,
): { props?: Record<string, unknown> }[] {
  const found: { props?: Record<string, unknown> }[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      const node = value as { kind?: string; widget?: string; props?: Record<string, unknown> };
      if (node.widget === name) found.push({ props: node.props });
      for (const entry of Object.values(node)) visit(entry);
    }
  };
  visit(spec.blocks);
  visit(spec.header);
  return found;
}

test("composer carries the previewed filters into the send action", () => {
  const spec = statementBatchComposerSpec(stubData());
  const [send] = widgetsOf(spec as never, "statement-batch-send");
  assert.ok(send);
  assert.equal(send!.props?.recipientCount, 1);
  assert.deepEqual(send!.props?.body, {
    from: "2026-01-01",
    toDate: "2026-01-31",
    overdueOnly: false,
    subsidiaryId: null,
    currency: null,
  });
});

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

test("recipient names link their statement and exclusions link their fix", () => {
  const tables = tablesOf(statementBatchComposerSpec(stubData()));
  assert.equal(tables.length, 2);
  const nameCell = tables[0]!.columns![0]!.cell;
  assert.equal(nameCell.kind, "link");
  assert.ok(
    nameCell.href?.$.endsWith("statementHref"),
    `recipient links its statement (got ${nameCell.href?.$})`,
  );
  const fixCell = tables[1]!.columns![2]!.cell;
  assert.equal(fixCell.kind, "link");
  assert.ok(
    fixCell.href?.$.endsWith("fixHref"),
    `exclusion links its fix (got ${fixCell.href?.$})`,
  );
});
