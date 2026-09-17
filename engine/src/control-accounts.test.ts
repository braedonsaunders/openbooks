import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  assertValidControlAccountMappings,
  type ControlAccountRecord,
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from "./control-accounts.ts";
import { db, withBypass, withOrgContext } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

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
          /ar control account type income is incompatible/.test(error.message),
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
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "retainage receivable control mapping only accepts receivable-type accounts (F-t04-002)",
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
        /retainageReceivable control account type liability_payable is incompatible/.test(
          error.message,
        ),
    );
  },
);
