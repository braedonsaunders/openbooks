import { add, cmp, isZero, neg, sum } from "../money/money.ts";
import { type Doc, type DocLine, type PostingDeps, type TaxPostingComponent, PostingError } from "../journal/posting-contracts.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { resolveMarketplaceClearing } from "../tax/marketplace-facilitators.ts";

/**
 * Document kinds whose tax posts through the sales rule (output tax and
 * marketplace clearing). Cash-sale kinds join this set with the commerce
 * cash-documents change; the set is the only place a kind is admitted.
 */
export const MARKETPLACE_SALES_KINDS: ReadonlySet<string> = new Set([
  "customer_invoice",
  "customer_credit",
  "cash_sale",
  "cash_refund",
]);

/**
 * Marketplace collection is sales-side: a marketplace-collected component
 * reaching a purchase-side rule is a data fault (the flag was set on the
 * wrong document), refused here before it can move money.
 */
export function refuseMarketplaceOnPurchase(
  line: Pick<DocLine, "lineNumber">,
  components: TaxPostingComponent[],
): void {
  for (const component of components) {
    if (component.collectedBy === "marketplace") {
      throw new PostingError(
        `line ${line.lineNumber} carries marketplace-collected tax on a purchase document — marketplace collection is sales-side; clear the marketplace flag on the line`,
      );
    }
  }
}

/**
 * Resolve facilitator clearing accounts for a sales document carrying
 * marketplace-collected components, at the posting boundary. Skipped when
 * the caller already resolved them or the document carries none — orgs
 * without facilitators pay no query and need no configuration.
 */
export async function resolveMarketplaceClearingForDocument(
  runner: Pick<SqlExecutor, "execute">,
  doc: Pick<Doc, "kind" | "orgId">,
  deps: PostingDeps,
): Promise<PostingDeps> {
  if (deps.marketplaceClearingByName || !MARKETPLACE_SALES_KINDS.has(doc.kind)) return deps;
  const names = new Set<string>();
  for (const components of deps.taxComponentsByLine?.values() ?? []) {
    for (const component of components) {
      if (component.collectedBy === "marketplace" && component.facilitatorName) {
        names.add(component.facilitatorName);
      }
    }
  }
  if (names.size === 0) return deps;
  const resolved = await resolveMarketplaceClearing(runner, doc.orgId, [...names]);
  return {
    ...deps,
    marketplaceClearingByName: new Map(
      [...resolved].map(([name, clearing]) => [name, { accountId: clearing.accountId, mode: clearing.mode }]),
    ),
  };
}

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
  salesSide: boolean,
): TaxPostingComponent[] {
  const components = deps.taxComponentsByLine?.get(line.id) ?? [];
  // The purchase rules pass salesSide=false so a marketplace flag on the
  // wrong document is refused with the sales-side remedy before the
  // crossfoot below can misread it as an unconfigured facilitator.
  if (!salesSide) refuseMarketplaceOnPurchase(line, components);
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
    // Marketplace-collected tax settles through the facilitator, not the
    // merchant: gross-mode components ride inside the charged line total
    // (the clearing leg balances them), net-mode components are
    // reporting-only and sit outside it. Only standard output tax can be
    // facilitator-collected — withholding and reverse charge have no
    // marketplace meaning and fail closed here.
    let expected = "0";
    for (const component of components) {
      if (component.collectedBy !== "marketplace") continue;
      if (component.calculationType !== "standard") {
        throw new PostingError(
          `line ${line.lineNumber} carries marketplace-collected ${component.calculationType} tax — only standard output tax can be marketplace-collected`,
        );
      }
      const clearing = deps.marketplaceClearingByName?.get(component.facilitatorName ?? "");
      if (!clearing) {
        throw new PostingError(
          `line ${line.lineNumber} names marketplace facilitator "${component.facilitatorName ?? ""}" with no clearing account — configure the facilitator in Setup → Taxes → Marketplace facilitators`,
        );
      }
      if (clearing.mode === "gross") expected = add(expected, component.taxAmount);
    }
    const merchant = components.filter((c) => c.collectedBy !== "marketplace");
    const settlement = add(componentSettlementTotal(merchant), expected);
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
  const side = purchase.has(doc.kind)
    ? "purchase"
    : MARKETPLACE_SALES_KINDS.has(doc.kind)
      ? "sales"
      : null;
  if (!side) return;

  for (const line of lines) {
    for (const component of componentsForLine(line, deps, side === "sales")) {
      // A zero-value component produces no tax leg.  Nonzero taxable activity
      // must always have an explicit, immutable control-account destination.
      if (isZero(component.taxAmount)) continue;
      if (component.collectedBy === "marketplace") {
        if (side !== "sales") {
          throw new PostingError(
            `line ${line.lineNumber} carries marketplace-collected tax on a purchase document — marketplace collection is sales-side; clear the marketplace flag on the line`,
          );
        }
        // The clearing account (not the tax control) is asserted here: the
        // componentsForLine crossfoot above already refused an unconfigured
        // facilitator, so this re-read stays a pure lookup.
        const clearing = deps.marketplaceClearingByName?.get(component.facilitatorName ?? "");
        if (!clearing) {
          throw new PostingError(
            `line ${line.lineNumber} names marketplace facilitator "${component.facilitatorName ?? ""}" with no clearing account — configure the facilitator in Setup → Taxes → Marketplace facilitators`,
          );
        }
        continue;
      }
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
