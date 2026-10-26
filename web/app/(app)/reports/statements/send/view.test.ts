import assert from "node:assert/strict";
import test from "node:test";

const { statementBatchComposerSpec } = await import("./view");

function visit(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, found);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    found.push(record);
    for (const entry of Object.values(record)) visit(entry, found);
  }
  return found;
}

test("an invalid statement period stays visible and prevents sending with fallback dates", () => {
  const periodError = "statement batch period starts after it ends — swap the From and To dates";
  const spec = statementBatchComposerSpec({
    title: "Send statements",
    backHref: "/reports/statements",
    backLabel: "Statements",
    company: "Example Co",
    periodPhrase: "Balances as of today",
    dateRange: { from: "", to: "" },
    columnCustomer: "Customer",
    columnBalance: "Balance",
    columnOverdue: "Overdue",
    columnEmail: "Email",
    columnFix: "Fix",
    rows: [],
    exclusions: [],
    summary: "0 ready to send",
    hasRows: false,
    hasExclusions: false,
    subsidiaries: [],
    primaryFilter: null,
    overdueAllHref: "/reports/statements/send",
    overdueOnlyHref: "/reports/statements/send?overdueOnly=1",
    overdueActive: false,
    overdueAllActive: true,
    overdueAllLabel: "All balances",
    overdueOnlyLabel: "Overdue only",
    emptyTitle: "No customers with balances",
    emptyHint: "Post an invoice.",
    exclusionsTitle: "No email",
    send: {
      canCreate: false,
      notAllowed: periodError,
      buttonLabel: "Send statements",
      sendingLabel: "Sending",
      recipientCount: 0,
      viewBatchesHref: "/reports/statements/sends",
      viewBatchesLabel: "View batches",
      body: {
        from: null,
        toDate: "2026-10-19",
        overdueOnly: false,
        subsidiaryId: null,
        currency: null,
      },
    },
    currencyBasisBlocked: null,
    currencyBasisReady: false,
    periodInputError: periodError,
    periodInputBlocked: true,
  } as never);

  const nodes = visit(spec);
  const send = nodes.find((node) => node.widget === "statement-batch-send");
  assert.ok(send, "the send control remains in the composer");
  const sendProps = send.props as Record<string, unknown>;
  assert.equal(
    sendProps.canCreate,
    false,
    "the invalid query cannot create a batch using fallback dates",
  );
  assert.equal(sendProps.notAllowed, periodError, "the operator sees the correction");
  assert.ok(
    nodes.some((node) => node.widget === "empty-state"),
    "the invalid period is shown as a blocking page state",
  );
});
