import { add, cmp, isZero, neg, sum } from "../money/money.ts";
import { type Doc, type DocLine, type PostingDeps, type TaxPostingComponent, PostingError } from "./posting-contracts.ts";
function componentSettlementTotal(components: TaxPostingComponent[]): string {
  const standard = sum(
    components
      .filter((c) => c.calculationType === "standard")
      .map((c) => c.taxAmount),
  );
  const withholding = sum(
    components
      .filter((c) => c.calculationType === "withholding")
      .map((c) => c.taxAmount),
  );
  return add(standard, neg(withholding));
}

export function componentsForLine(
  line: DocLine,
  deps: PostingDeps,
): TaxPostingComponent[] {
  const components = deps.taxComponentsByLine?.get(line.id) ?? [];
  const hasTaxProfile = Boolean(line.taxCodeId || line.taxGroupId);
  if (hasTaxProfile && components.length === 0) {
    throw new PostingError(
      `line ${line.lineNumber} has a tax profile but no calculation evidence`,
    );
  }
  if (!hasTaxProfile && components.length === 0 && !isZero(line.taxAmount ?? "0")) {
    throw new PostingError(
      `line ${line.lineNumber} has a tax amount but no calculation evidence`,
    );
  }
  if (components.length > 0) {
    const settlement = componentSettlementTotal(components);
    if (cmp(settlement, line.taxAmount ?? "0") !== 0) {
      throw new PostingError(
        `line ${line.lineNumber} tax components (${settlement}) do not match stored tax total (${line.taxAmount})`,
      );
    }
  }
  return components;
}

/**
 * Resolve a tax component's control account exactly as it was configured at
 * posting time.  AP/AR are deliberately not valid fallbacks: a taxable line
 * without a dedicated or org-level tax control account must fail closed before
 * any journal or post-commit evidence is written.
 */
function taxControlAccount(
  component: TaxPostingComponent,
  deps: PostingDeps,
  side: "collected" | "paid",
): string | null {
  const configured = side === "collected"
    ? component.collectedAccountId ?? deps.taxCollectedByCode?.get(component.taxCodeId) ?? deps.control.taxCollected
    : component.paidAccountId ?? deps.taxPaidByCode?.get(component.taxCodeId) ?? deps.control.taxPaid;
  return configured && configured.length > 0 ? configured : null;
}

export function assertTaxControlAccount(
  component: TaxPostingComponent,
  deps: PostingDeps,
  side: "collected" | "paid" | "withholding",
): string {
  if (side === "withholding") {
    if (!component.withholdingAccountId) {
      throw new PostingError(
        `withholding tax ${component.taxCodeId} has no withholding account`,
      );
    }
    return component.withholdingAccountId;
  }
  const account = taxControlAccount(component, deps, side);
  if (!account) {
    throw new PostingError(
      `${side} tax ${component.taxCodeId} has no configured tax control account`,
    );
  }
  return account;
}

/** Validate every tax control leg before scripts, flows, or ledger writes. */
export function validateTaxControlAccounts(
  doc: Doc,
  lines: DocLine[],
  deps: PostingDeps,
): void {
  const purchase = new Set([
    "vendor_bill",
    "vendor_credit",
    "expense_report",
    "check",
    "card_charge",
    "card_refund",
  ]);
  const sales = new Set(["customer_invoice", "customer_credit"]);
  const side = purchase.has(doc.kind)
    ? "purchase"
    : sales.has(doc.kind)
      ? "sales"
      : null;
  if (!side) return;

  for (const line of lines) {
    for (const component of componentsForLine(line, deps)) {
      // A zero-value component produces no tax leg.  Nonzero taxable activity
      // must always have an explicit, immutable control-account destination.
      if (isZero(component.taxAmount)) continue;
      if (component.calculationType === "withholding") {
        assertTaxControlAccount(component, deps, "withholding");
      } else if (side === "sales") {
        if (component.calculationType !== "reverse_charge") {
          assertTaxControlAccount(component, deps, "collected");
        }
      } else {
        if (!isZero(component.recoverableAmount)) {
          assertTaxControlAccount(component, deps, "paid");
        }
        if (component.calculationType === "reverse_charge") {
          assertTaxControlAccount(component, deps, "collected");
        }
      }
    }
  }
}
