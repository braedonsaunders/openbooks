import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });
import { sql } from "drizzle-orm";
import { db, withBypass } from "@openbooks/engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";

const { validateReferences, BANK_ACCOUNT_TYPE } = await import("./category-references.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;
const GHOST = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function bankSpec(ids: string[], allowedSubs: Set<string> | null = null) {
  return [
    {
      field: "bankAccountIds",
      table: "accounts" as const,
      kind: "an account",
      ids,
      allowedSubsidiaryIds: allowedSubs,
      expectAccountType: BANK_ACCOUNT_TYPE as typeof BANK_ACCOUNT_TYPE,
    },
  ];
}

// The unit double never runs SQL: only a live database proves the array
// binding, the org scoping, and the subsidiary scoping refuse for real.
test("reference validation resolves a genuine account", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const error = await withBypass(() =>
      validateReferences(org.orgId, bankSpec([org.accounts.bank])),
    );
    assert.equal(error, null);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("reference validation refuses malformed, missing, and foreign ids", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  const foreign = await withBypass(() => createScratchOrg());
  try {
    assert.equal(
      await withBypass(() => validateReferences(org.orgId, bankSpec(["not-a-uuid"]))),
      'bankAccountIds "not-a-uuid" is not a valid UUID',
    );
    assert.equal(
      await withBypass(() => validateReferences(org.orgId, bankSpec([GHOST]))),
      `bankAccountIds "${GHOST}" is not an account in this organization`,
    );
    assert.equal(
      await withBypass(() => validateReferences(org.orgId, bankSpec([foreign.accounts.bank]))),
      `bankAccountIds "${foreign.accounts.bank}" is not an account in this organization`,
    );
    // A real bank id from another org refuses even though the row exists:
    // scope is org-first, proved against live rows, not the mock.
    assert.match(
      (await withBypass(() => validateReferences(org.orgId, bankSpec([foreign.accounts.bank])))) ?? "",
      /not an account in this organization/,
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
    await withBypass(() => dropScratchOrg(foreign.orgId));
  }
});

test("reference validation enforces type, postability, role, and subsidiaries", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(async () => {
      // parties.kind is only the primary kind: the vendor holds its role
      // explicitly, and the customer below holds one too despite its kind.
      await db.execute(sql`insert into vendor_roles(id,org_id,party_id)
        values (${randomUUID()},${org.orgId},${org.vendorId}),(${randomUUID()},${org.orgId},${org.customerId})`);
    });
    // Wrong type: an expense account is not a bank account.
    assert.equal(
      await withBypass(() => validateReferences(org.orgId, bankSpec([org.accounts.adjustment]))),
      `bankAccountIds "${org.accounts.adjustment}" must be a bank account (asset_bank), got "expense"`,
    );
    // Summary accounts are not postable GL sources.
    const summary = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_summary)
        values (${summary},${org.orgId},'9999','Summary','expense',true)`);
    });
    assert.equal(
      await withBypass(() =>
        validateReferences(org.orgId, [
          {
            field: "accountIds",
            table: "accounts",
            kind: "an account",
            ids: [summary],
            allowedSubsidiaryIds: null,
            expectPostable: true,
          },
        ]),
      ),
      `accountIds "${summary}" must be a postable account, not a summary account`,
    );
    // Vendor methods read vendor-role holders: the customer-kind party above
    // holds a vendor role and saves.
    assert.equal(
      await withBypass(() =>
        validateReferences(org.orgId, [
          {
            field: "partyIds",
            table: "parties",
            kind: "a party",
            ids: [org.customerId],
            allowedSubsidiaryIds: null,
            expectVendorRole: true,
          },
        ]),
      ),
      null,
    );
    assert.equal(
      await withBypass(() =>
        validateReferences(org.orgId, [
          {
            field: "partyIds",
            table: "parties",
            kind: "a party",
            ids: [org.vendorId],
            allowedSubsidiaryIds: null,
            expectVendorRole: true,
          },
        ]),
      ),
      null,
    );
    // A party with no vendor role refuses, whatever its primary kind.
    const stranger = randomUUID();
    await withBypass(async () => {
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active,custom)
        values (${stranger},${org.orgId},'vendor','No Role',true,'{}'::jsonb)`);
    });
    assert.equal(
      await withBypass(() =>
        validateReferences(org.orgId, [
          {
            field: "partyIds",
            table: "parties",
            kind: "a party",
            ids: [stranger],
            allowedSubsidiaryIds: null,
            expectVendorRole: true,
          },
        ]),
      ),
      `partyIds "${stranger}" is not a vendor in this organization`,
    );
    // Subsidiary scope: park the bank inside the scratch subsidiary, then a
    // caller blind to it refuses while an org-wide row still passes.
    await withBypass(async () => {
      await db.execute(sql`update accounts set subsidiary_id = ${org.subsidiaryId} where id = ${org.accounts.bank}`);
    });
    assert.equal(
      await withBypass(() => validateReferences(org.orgId, bankSpec([org.accounts.bank], new Set()))),
      `bankAccountIds "${org.accounts.bank}" is outside your subsidiaries`,
    );
    assert.equal(
      await withBypass(() =>
        validateReferences(org.orgId, bankSpec([org.accounts.bank], new Set([org.subsidiaryId]))),
      ),
      null,
    );
    assert.equal(
      await withBypass(() =>
        validateReferences(org.orgId, [
          {
            field: "accountIds",
            table: "accounts",
            kind: "an account",
            ids: [org.accounts.adjustment],
            allowedSubsidiaryIds: new Set(),
            expectPostable: true,
          },
        ]),
      ),
      null,
      "org-wide rows stay visible to restricted callers",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
