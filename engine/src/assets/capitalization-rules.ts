import { cmp } from "../money/money.ts";

/**
 * Capitalization rules decide which posted purchase lines become asset
 * proposals. A rule names one account, one item or one item category, an
 * optional legal entity, a minimum amount and an effective window. Rules
 * are matched against the posting date of the source line, so ending a rule
 * and starting another never reinterprets lines already proposed.
 */
export interface CapitalizationRule {
  id: string;
  name: string;
  subsidiaryId: string | null;
  matchKind: "account" | "item" | "item_category";
  accountId: string | null;
  itemId: string | null;
  itemCategory: string | null;
  assetCategoryId: string | null;
  minimumAmount: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface ProposalSourceLine {
  subsidiaryId: string;
  accountId: string;
  itemId: string | null;
  itemCategory: string | null;
  /** Base-currency debit on the source line; always positive for a candidate. */
  amount: string;
  postingDate: string;
}

const SPECIFICITY: Record<CapitalizationRule["matchKind"], number> = {
  item: 0,
  item_category: 1,
  account: 2,
};

function normalizeCategory(value: string | null): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return trimmed.length ? trimmed : null;
}

/** Whether a rule is in force for a line's entity and posting date. */
export function ruleInForce(
  rule: CapitalizationRule,
  line: Pick<ProposalSourceLine, "subsidiaryId" | "postingDate">,
): boolean {
  if (!rule.isActive) return false;
  if (rule.subsidiaryId !== null && rule.subsidiaryId !== line.subsidiaryId) return false;
  if (line.postingDate < rule.effectiveFrom) return false;
  if (rule.effectiveTo !== null && line.postingDate > rule.effectiveTo) return false;
  return true;
}

function ruleMatches(rule: CapitalizationRule, line: ProposalSourceLine): boolean {
  switch (rule.matchKind) {
    case "account":
      return rule.accountId === line.accountId;
    case "item":
      return line.itemId !== null && rule.itemId === line.itemId;
    case "item_category": {
      const wanted = normalizeCategory(rule.itemCategory);
      return wanted !== null && wanted === normalizeCategory(line.itemCategory);
    }
  }
}

/**
 * The single rule that proposes this line, or null. The most specific match
 * wins (item, then item category, then account); among equals, an
 * entity-specific rule beats an organization-wide one, then the latest
 * effective date, then the rule id, so the choice is deterministic. A line
 * below the winning rule's minimum is not proposed: the minimum is the
 * organization's capitalization threshold for that kind of purchase.
 */
export function matchCapitalizationRule(
  rules: readonly CapitalizationRule[],
  line: ProposalSourceLine,
): CapitalizationRule | null {
  if (cmp(line.amount, "0") <= 0) return null;
  const candidates = rules
    .filter((rule) => ruleInForce(rule, line) && ruleMatches(rule, line))
    .sort(
      (a, b) =>
        SPECIFICITY[a.matchKind] - SPECIFICITY[b.matchKind] ||
        Number(b.subsidiaryId !== null) - Number(a.subsidiaryId !== null) ||
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        a.id.localeCompare(b.id),
    );
  const winner = candidates[0] ?? null;
  if (!winner) return null;
  return cmp(line.amount, winner.minimumAmount) >= 0 ? winner : null;
}
