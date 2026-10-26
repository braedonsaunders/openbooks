import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubsidiaryContext } from "../organization/subsidiaries.ts";
import {
  accountClassOf,
  bookAccountMapRefusal,
  bookAccountMapScopeRefusal,
  type MappableAccount,
} from "./book-account-maps.ts";

function account(id: string, type: string, extra: Partial<MappableAccount> = {}): MappableAccount {
  return {
    id,
    label: id,
    type,
    isActive: true,
    isSummary: false,
    currencyRestriction: null,
    subsidiaryId: null,
    subsidiaryIncludeChildren: true,
    ...extra,
  };
}

const ROOT = "root";
const CHILD = "child";
const OTHER = "other";
const ctx: SubsidiaryContext = {
  byId: new Map([
    [
      ROOT,
      {
        id: ROOT,
        name: "Holdings",
        parentId: null,
        baseCurrency: "USD",
        isElimination: false,
        isActive: true,
      },
    ],
    [
      CHILD,
      {
        id: CHILD,
        name: "Child",
        parentId: ROOT,
        baseCurrency: "USD",
        isElimination: false,
        isActive: true,
      },
    ],
    [
      OTHER,
      {
        id: OTHER,
        name: "Other",
        parentId: ROOT,
        baseCurrency: "EUR",
        isElimination: false,
        isActive: true,
      },
    ],
  ]),
  rootId: ROOT,
  multi: true,
};

test("account types resolve to their statement class", () => {
  assert.equal(accountClassOf("asset_bank"), "asset");
  assert.equal(accountClassOf("liability_long_term"), "liability");
  assert.equal(accountClassOf("equity"), "equity");
  assert.equal(accountClassOf("income_other"), "income");
  assert.equal(accountClassOf("cogs"), "expense");
  assert.equal(accountClassOf("statistical"), null);
});

test("a mapping keeps the statement class", () => {
  assert.equal(bookAccountMapRefusal(account("a", "expense"), account("b", "expense_other")), null);
  assert.match(
    bookAccountMapRefusal(account("a", "expense"), account("b", "asset_fixed")) ?? "",
    /keeps the account's statement class/,
  );
  assert.match(
    bookAccountMapRefusal(account("a", "income"), account("b", "liability_current_other")) ?? "",
    /income and b is liability/,
  );
});

test("a mapping refuses unusable or currency-incompatible book accounts", () => {
  assert.match(
    bookAccountMapRefusal(account("a", "expense"), account("a", "expense")) ?? "",
    /cannot map to itself/,
  );
  assert.match(
    bookAccountMapRefusal(account("a", "expense"), account("b", "expense", { isSummary: true })) ??
      "",
    /summary account/,
  );
  assert.match(
    bookAccountMapRefusal(account("a", "expense"), account("b", "expense", { isActive: false })) ??
      "",
    /inactive/,
  );
  assert.match(
    bookAccountMapRefusal(
      account("a", "asset_bank"),
      account("b", "asset_bank", { currencyRestriction: "EUR" }),
    ) ?? "",
    /only accepts EUR postings/,
  );
  assert.equal(
    bookAccountMapRefusal(
      account("a", "asset_bank", { currencyRestriction: "EUR" }),
      account("b", "asset_bank", { currencyRestriction: "EUR" }),
    ),
    null,
  );
});

test("types outside the statement classes map only to the same type", () => {
  assert.equal(
    bookAccountMapRefusal(account("a", "statistical"), account("b", "statistical")),
    null,
  );
  assert.match(
    bookAccountMapRefusal(account("a", "statistical"), account("b", "expense")) ?? "",
    /same type/,
  );
});

test("the book account must be available wherever the mapping applies", () => {
  const restrictedToChild = account("b", "expense", {
    subsidiaryId: CHILD,
    subsidiaryIncludeChildren: false,
  });
  assert.equal(
    bookAccountMapScopeRefusal(ctx, account("a", "expense"), restrictedToChild, CHILD),
    null,
  );
  assert.match(
    bookAccountMapScopeRefusal(ctx, account("a", "expense"), restrictedToChild, OTHER) ?? "",
    /not available to subsidiary "Other"/,
  );
  // An organization-wide mapping covers every subsidiary the chart account admits.
  assert.match(
    bookAccountMapScopeRefusal(ctx, account("a", "expense"), restrictedToChild, null) ?? "",
    /organization-wide mapping covers/,
  );
  const sourceOnChild = account("a", "expense", {
    subsidiaryId: CHILD,
    subsidiaryIncludeChildren: false,
  });
  assert.equal(bookAccountMapScopeRefusal(ctx, sourceOnChild, restrictedToChild, null), null);
});
