import { fromUnits, toUnits } from "../money.ts";
import type { QbdReportRow } from "../qbd/qbxml.ts";
import type { NativeContext, NativeDocument } from "./native.ts";

function cleanAmount(value: string | undefined): string {
  const normalized = String(value ?? "").replaceAll(",", "").trim();
  return normalized === "" ? "0" : normalized;
}

export function buildQbdLedgerDocuments(input: {
  rows: QbdReportRow[];
  accountRefByName: Map<string, string>;
  partyRefByName: Map<string, string>;
  ctx: NativeContext;
  baseCurrency: string;
}): { documents: NativeDocument[]; unbuildable: { ref: string; reason: string }[] } {
  const grouped = new Map<string, QbdReportRow[]>();
  for (const row of input.rows) {
    const txnId = row.columns.TxnID;
    if (!txnId) continue;
    const group = grouped.get(txnId) ?? [];
    group.push(row);
    grouped.set(txnId, group);
  }

  const documents: NativeDocument[] = [];
  const unbuildable: { ref: string; reason: string }[] = [];
  for (const [txnId, transaction] of grouped) {
    const first = transaction.find((row) => row.columns.Date) ?? transaction[0]!;
    const lines: NativeDocument["lines"] = [];
    let sum = 0n;
    for (const row of transaction) {
      const accountRef = input.accountRefByName.get(row.columns.Account ?? "");
      const account = accountRef ? input.ctx.accountByRef.get(accountRef) : undefined;
      if (!account) continue;
      const amount = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
      if (amount === 0n) continue;
      sum += amount;
      const partyRef = input.partyRefByName.get(row.columns.Name ?? "");
      lines.push({
        accountId: account.id,
        itemId: null,
        partyId: partyRef ? input.ctx.partyByRef.get(partyRef) ?? null : null,
        amount: fromUnits(amount),
        taxAmount: "0",
        taxOverridden: false,
        taxCodeId: null,
        departmentId: null,
        projectId: null,
        description: row.columns.Memo || row.columns.SplitAccount || null,
        lineNumber: lines.length + 1,
      });
    }
    if (lines.length < 2 || sum !== 0n) {
      unbuildable.push({
        ref: txnId,
        reason: lines.length < 2
          ? "ledger transaction has fewer than two mapped lines"
          : `ledger transaction is out of balance by ${fromUnits(sum)}`,
      });
      continue;
    }
    documents.push({
      sourceRef: txnId,
      kind: "journal",
      posting: true,
      partyId: null,
      currency: input.baseCurrency,
      fxRate: "1",
      documentDate: first.columns.Date,
      dueDate: null,
      memo: first.columns.Memo || first.columns.TxnType || null,
      referenceNumber: first.columns.RefNumber || null,
      controlAccountId: null,
      lines,
    });
  }
  return { documents, unbuildable };
}
