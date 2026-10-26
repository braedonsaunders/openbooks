import assert from "node:assert/strict";
import test from "node:test";
import {
  matchCapitalizationRule,
  ruleInForce,
  type CapitalizationRule,
  type ProposalSourceLine,
} from "./capitalization-rules.ts";

const rule = (overrides: Partial<CapitalizationRule> & { id: string }): CapitalizationRule => ({
  name: overrides.id,
  subsidiaryId: null,
  matchKind: "account",
  accountId: "acct-equipment-clearing",
  itemId: null,
  itemCategory: null,
  assetCategoryId: "cat-equipment",
  minimumAmount: "2500",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  isActive: true,
  ...overrides,
});

const line = (overrides: Partial<ProposalSourceLine> = {}): ProposalSourceLine => ({
  subsidiaryId: "sub-a",
  accountId: "acct-equipment-clearing",
  itemId: null,
  itemCategory: null,
  amount: "4800.00",
  postingDate: "2026-07-15",
  ...overrides,
});

test("an account rule proposes a line at or above its threshold and nothing below it", () => {
  const rules = [rule({ id: "clearing" })];
  assert.equal(matchCapitalizationRule(rules, line())?.id, "clearing");
  assert.equal(
    matchCapitalizationRule(rules, line({ amount: "2500.0000" }))?.id,
    "clearing",
    "the threshold is inclusive",
  );
  assert.equal(matchCapitalizationRule(rules, line({ amount: "2499.99" })), null);
  assert.equal(
    matchCapitalizationRule(rules, line({ amount: "-4800" })),
    null,
    "credits are never proposed",
  );
  assert.equal(matchCapitalizationRule(rules, line({ accountId: "acct-office-supplies" })), null);
});

test("rules apply only inside their effective window, entity and active state", () => {
  const ended = rule({ id: "old", effectiveFrom: "2025-01-01", effectiveTo: "2026-06-30" });
  assert.equal(ruleInForce(ended, line({ postingDate: "2026-06-30" })), true);
  assert.equal(ruleInForce(ended, line({ postingDate: "2026-07-01" })), false);
  assert.equal(ruleInForce(rule({ id: "future", effectiveFrom: "2026-08-01" }), line()), false);
  assert.equal(ruleInForce(rule({ id: "other-entity", subsidiaryId: "sub-b" }), line()), false);
  assert.equal(ruleInForce(rule({ id: "off", isActive: false }), line()), false);
});

test("a new threshold from a date never reinterprets earlier postings", () => {
  const rules = [
    rule({
      id: "2025-policy",
      minimumAmount: "1000",
      effectiveFrom: "2025-01-01",
      effectiveTo: "2026-06-30",
    }),
    rule({ id: "2026-policy", minimumAmount: "5000", effectiveFrom: "2026-07-01" }),
  ];
  assert.equal(
    matchCapitalizationRule(rules, line({ amount: "1200", postingDate: "2026-06-15" }))?.id,
    "2025-policy",
  );
  assert.equal(
    matchCapitalizationRule(rules, line({ amount: "1200", postingDate: "2026-07-15" })),
    null,
  );
  assert.equal(
    matchCapitalizationRule(rules, line({ amount: "5000", postingDate: "2026-07-15" }))?.id,
    "2026-policy",
  );
});

test("the most specific rule wins: item, then item category, then account", () => {
  const rules = [
    rule({ id: "account" }),
    rule({
      id: "category",
      matchKind: "item_category",
      accountId: null,
      itemCategory: " Equipment ",
    }),
    rule({
      id: "item",
      matchKind: "item",
      accountId: null,
      itemId: "item-forklift",
      minimumAmount: "0",
    }),
  ];
  assert.equal(
    matchCapitalizationRule(rules, line({ itemId: "item-forklift", itemCategory: "equipment" }))
      ?.id,
    "item",
  );
  assert.equal(
    matchCapitalizationRule(rules, line({ itemId: "item-drill", itemCategory: "EQUIPMENT" }))?.id,
    "category",
    "category match ignores case and padding",
  );
  assert.equal(
    matchCapitalizationRule(rules, line({ itemId: "item-paper", itemCategory: "Consumables" }))?.id,
    "account",
  );
  // The winning rule's threshold decides; a looser, less specific rule never rescues a line.
  const strictItem = [
    rule({ id: "account", minimumAmount: "0" }),
    rule({
      id: "item",
      matchKind: "item",
      accountId: null,
      itemId: "item-forklift",
      minimumAmount: "10000",
    }),
  ];
  assert.equal(matchCapitalizationRule(strictItem, line({ itemId: "item-forklift" })), null);
});

test("ties break deterministically: entity-specific, then latest effective date, then id", () => {
  const rules = [
    rule({ id: "b-org", minimumAmount: "0" }),
    rule({ id: "a-entity", subsidiaryId: "sub-a", minimumAmount: "0" }),
  ];
  assert.equal(matchCapitalizationRule(rules, line())?.id, "a-entity");
  const dated = [
    rule({ id: "z-early", effectiveFrom: "2026-01-01" }),
    rule({ id: "y-late", effectiveFrom: "2026-03-01" }),
  ];
  assert.equal(matchCapitalizationRule(dated, line())?.id, "y-late");
  const same = [rule({ id: "b" }), rule({ id: "a" })];
  assert.equal(matchCapitalizationRule(same, line())?.id, "a");
});
