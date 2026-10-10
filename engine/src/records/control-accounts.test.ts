import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  assertValidControlAccountMappings,
  CONTROL_ACCOUNT_ROLE_LABELS,
  CONTROL_ACCOUNT_ROLES,
  CONTROL_ACCOUNT_TYPE_LABELS,
  CONTROL_ACCOUNT_TYPE_POLICY,
  type ControlAccountRecord,
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from "./control-accounts.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

test(
  "posting-time control-account loading fails closed on legacy-invalid mappings",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      // Simulate a legacy/import/direct JSON write that bypassed the settings
      // route: AR points at an active postable account, but it is revenue and
      // therefore carries the wrong accounting semantics for receivables.
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(
               settings,
               '{controlAccounts,ar}',
               to_jsonb(${org.accounts.revenue}::text),
               true
             )
           where id = ${org.orgId}`),
      );

      await assert.rejects(
        () =>
          withOrgContext(org.orgId, () =>
            loadRequiredControlAccounts(org.orgId),
          ),
        (error: unknown) =>
          error instanceof ControlAccountsIncompleteError &&
          /Accounts receivable control account must be Accounts receivable; the selected account is Income/.test(error.message) &&
          error.role === "ar" && error.reason === "type",
      );

      // Happy path: repairing the stored role restores the posting dependency
      // loader without changing its ar/ap/bank contract.
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
          update orgs
             set settings = jsonb_set(
               settings,
               '{controlAccounts,ar}',
               to_jsonb(${org.accounts.ar}::text),
               true
             )
           where id = ${org.orgId}`),
      );
      const valid = await withOrgContext(org.orgId, () =>
        loadRequiredControlAccounts(org.orgId),
      );
      assert.deepEqual(valid, {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
        taxCollected: undefined,
        taxPaid: undefined,
        employeePayable: undefined,
        employeeReceivable: undefined,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "retainage receivable control mapping only accepts receivable-type accounts",
  () => {
    const receivable: ControlAccountRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "asset_receivable",
      isActive: true,
      isSummary: false,
    };
    assertValidControlAccountMappings(
      { retainageReceivable: receivable.id },
      [receivable],
    );
    const payable: ControlAccountRecord = {
      ...receivable,
      id: "22222222-2222-4222-8222-222222222222",
      type: "liability_payable",
    };
    assert.throws(
      () =>
        assertValidControlAccountMappings(
          { retainageReceivable: payable.id },
          [payable],
        ),
      (error: unknown) =>
        error instanceof ControlAccountsIncompleteError &&
        /Retainage receivable control account must be Accounts receivable or Other current asset; the selected account is Accounts payable/.test(
          error.message,
        ),
    );
  },
);

test("every role and every accepted account type has an operator-facing name", () => {
  for (const role of CONTROL_ACCOUNT_ROLES) {
    const label = CONTROL_ACCOUNT_ROLE_LABELS[role];
    assert.ok(label && label !== role, `${role} needs a human label`);
    for (const type of CONTROL_ACCOUNT_TYPE_POLICY[role]) {
      assert.ok(CONTROL_ACCOUNT_TYPE_LABELS[type], `${type} needs a human label`);
    }
  }
});

test("a mistyped mapping is refused by the role's name and expected type, never its storage key", () => {
  const clearing: ControlAccountRecord = {
    id: "33333333-3333-4333-8333-333333333333",
    type: "asset_current_other",
    isActive: true,
    isSummary: false,
  };
  assert.throws(
    () => assertValidControlAccountMappings({ translationAdjustment: clearing.id }, [clearing]),
    (error: unknown) =>
      error instanceof ControlAccountsIncompleteError &&
      error.message === "Translation adjustment control account must be Equity; the selected account is Other current asset" &&
      error.role === "translationAdjustment" &&
      error.reason === "type" &&
      error.accountType === "asset_current_other" &&
      JSON.stringify(error.allowedTypes) === JSON.stringify(["equity"]),
  );
  const revenue: ControlAccountRecord = { ...clearing, type: "income" };
  assert.throws(
    () => assertValidControlAccountMappings({ laborClearing: revenue.id }, [revenue]),
    (error: unknown) =>
      error instanceof ControlAccountsIncompleteError &&
      error.message === "Labor clearing control account must be Other current asset or Other current liability; the selected account is Income" &&
      !error.message.includes("laborClearing"),
  );
  // An accepted type passes for the same role.
  assertValidControlAccountMappings({ laborClearing: clearing.id }, [clearing]);
});

test("received-not-billed control mapping only accepts payable-family accounts", () => {
  const payable: ControlAccountRecord = {
    id: "44444444-4444-4444-8444-444444444444",
    type: "liability_payable",
    isActive: true,
    isSummary: false,
  };
  assertValidControlAccountMappings({ receivedNotBilled: payable.id }, [payable]);
  const currentOther: ControlAccountRecord = {
    ...payable,
    id: "55555555-5555-4555-8555-555555555555",
    type: "liability_current_other",
  };
  assertValidControlAccountMappings({ receivedNotBilled: currentOther.id }, [currentOther]);
  const asset: ControlAccountRecord = {
    ...payable,
    id: "66666666-6666-4666-8666-666666666666",
    type: "asset_current_other",
  };
  assert.throws(
    () => assertValidControlAccountMappings({ receivedNotBilled: asset.id }, [asset]),
    (error: unknown) =>
      error instanceof ControlAccountsIncompleteError &&
      error.message ===
        "Received not billed control account must be Accounts payable or Other current liability; the selected account is Other current asset" &&
      error.role === "receivedNotBilled" &&
      error.reason === "type",
  );
});
