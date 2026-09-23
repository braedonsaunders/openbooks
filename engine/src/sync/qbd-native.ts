import { fromUnits, toUnits } from "../money/money.ts";
import { parseQbdReportDate, type QbdReportRow } from "../qbd/qbxml.ts";
import type { NativeContext, NativeDocument } from "./native.ts";

function cleanAmount(value: string | undefined): string {
  const normalized = String(value ?? "").replaceAll(",", "").trim();
  return normalized === "" ? "0" : normalized;
}

export type QbdPartyFamily = "customer" | "vendor" | "employee";

function resolveQbdLineParty(args: {
  txnId: string;
  sourceAccount: string;
  accountId: string;
  rawName: string | undefined;
  partyRefByFamily: Record<QbdPartyFamily, Map<string, string>>;
  ctx: NativeContext;
}): { partyId: string | null; failure: string | null } {
  const name = (args.rawName ?? "").trim();
  const isAR = args.accountId === args.ctx.control.ar;
  const isAP = args.accountId === args.ctx.control.ap;
  const isEmployeePayable =
    args.ctx.control.employeePayable != null && args.accountId === args.ctx.control.employeePayable;
  // The account class picks the family — never the name: a same-named vendor
  // never answers for an AR line. Control metadata comes from the ledger's
  // own control accounts, never an account-name match.
  const expected: QbdPartyFamily | null = isAR ? "customer" : isAP ? "vendor" : isEmployeePayable ? "employee" : null;
  if (!name) {
    // A null party is kept only when the source Name is truly empty and the
    // account does not require one: a control posting with no party cannot
    // reconcile to party-level AR/AP.
    if (!expected) return { partyId: null, failure: null };
    return {
      partyId: null,
      failure: `ledger transaction ${args.txnId}: ${args.sourceAccount} requires a party but the line has no name — supply the customer/vendor name before import`,
    };
  }
  const families: QbdPartyFamily[] = expected ? [expected] : ["customer", "vendor", "employee"];
  const hits = families.filter((family) => args.partyRefByFamily[family].has(name));
  if (expected) {
    if (hits.length === 1) {
      const partyId = args.ctx.partyByRef.get(args.partyRefByFamily[expected].get(name)!) ?? null;
      if (partyId) return { partyId, failure: null };
    }
    return {
      partyId: null,
      failure: `ledger transaction ${args.txnId}: party ${name} on ${args.sourceAccount} is not mapped — map the customer/vendor before import`,
    };
  }
  if (hits.length === 1) {
    const family = hits[0]!;
    return { partyId: args.ctx.partyByRef.get(args.partyRefByFamily[family].get(name)!) ?? null, failure: null };
  }
  if (hits.length === 0) {
    return {
      partyId: null,
      failure: `ledger transaction ${args.txnId}: party ${name} on ${args.sourceAccount} is not mapped — map the customer/vendor before import`,
    };
  }
  return {
    partyId: null,
    failure: `ledger transaction ${args.txnId}: party ${name} on ${args.sourceAccount} is ambiguous (a ${hits[0]} and a ${hits[1]} share the name) — resolve the duplicate name before import`,
  };
}

export function buildQbdLedgerDocuments(input: {
  rows: QbdReportRow[];
  accountRefByName: Map<string, string>;
  partyRefByFamily: Record<QbdPartyFamily, Map<string, string>>;
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
    // Report dates are locale display strings (M/D/YYYY); the native document
    // requires ISO. A transaction with no parseable date cannot be posted to
    // the right period, so it is refused per-transaction rather than mis-dated.
    let documentDate: string | null = null;
    try {
      documentDate = first.columns.Date ? parseQbdReportDate(first.columns.Date) : null;
    } catch {
      documentDate = null;
    }
    if (!documentDate) {
      unbuildable.push({ ref: txnId, reason: "ledger transaction has no parseable report date" });
      continue;
    }
    const lines: NativeDocument["lines"] = [];
    let sum = 0n;
    const unmappedAccounts: string[] = [];
    let partyFailure: string | null = null;
    for (const row of transaction) {
      const amount = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
      const sourceAccount = row.columns.Account ?? "";
      const accountRef = input.accountRefByName.get(sourceAccount);
      const account = accountRef ? input.ctx.accountByRef.get(accountRef) : undefined;
      if (!account) {
        // An unmapped leg with a nonzero amount fails the whole transaction:
        // dropping it imported "balanced" journals missing half their
        // postings. Zero-amount rows post nothing and are still skipped.
        if (amount !== 0n) unmappedAccounts.push(sourceAccount);
        continue;
      }
      if (amount === 0n) continue;
      const party = resolveQbdLineParty({
        txnId,
        sourceAccount,
        accountId: account.id,
        rawName: row.columns.Name,
        partyRefByFamily: input.partyRefByFamily,
        ctx: input.ctx,
      });
      if (party.failure) {
        if (!partyFailure) partyFailure = party.failure;
        continue;
      }
      sum += amount;
      lines.push({
        accountId: account.id,
        itemId: null,
        partyId: party.partyId,
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
    if (unmappedAccounts.length > 0) {
      const names = [...new Set(unmappedAccounts.map((name) => name || "(unnamed account)"))];
      unbuildable.push({
        ref: txnId,
        reason: `ledger transaction ${txnId} has ${unmappedAccounts.length} line(s) on unmapped account(s): ${names.join(", ")} — map them before import`,
      });
      continue;
    }
    if (partyFailure) {
      unbuildable.push({ ref: txnId, reason: partyFailure });
      continue;
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
      documentDate,
      dueDate: null,
      memo: first.columns.Memo || first.columns.TxnType || null,
      referenceNumber: first.columns.RefNumber || null,
      controlAccountId: null,
      lines,
    });
  }
  return { documents, unbuildable };
}
