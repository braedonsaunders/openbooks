import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  orgContext,
  withBypass,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import {
  createPaymentBankProfile,
  ensureBuiltInPaymentFormats,
  updatePaymentBankProfile,
} from "./operations.ts";

const enabled = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "bank profile commands establish tenant authority and join the caller's atomic unit",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Bank profile administrator", "admin"),
      );
      const deniedId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Bank profile reader", "viewer"),
      );
      await withBypassContext(() =>
        grantScratchPermissions(org.orgId, actorId, ["admin.setup.manage"]),
      );
      await withOrgContext(org.orgId, () => ensureBuiltInPaymentFormats(org.orgId, actorId));
      const format = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ id: string }>(
            sql`
      select id from payment_formats where org_id=${org.orgId} and code='WIRE'
    `,
            "objects",
          ),
        )
      )[0]!;
      const input = {
        name: "Standalone profile",
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        paymentFormatId: format.id,
        currency: "CAD",
      };
      assert.equal(orgContext.getStore()?.txDb, undefined);
      const created = await createPaymentBankProfile(org.orgId, actorId, input);
      await updatePaymentBankProfile(created.id, org.orgId, actorId, {
        name: "Standalone revised",
      });
      const state = () =>
        withOrgContext(org.orgId, async () => ({
          profiles: await db.execute<{ id: string; name: string }>(
            sql`
        select id,name from payment_bank_profiles where org_id=${org.orgId} order by id
      `,
            "objects",
          ),
          audit: await db.execute<{ id: string }>(
            sql`
        select id from audit_log where org_id=${org.orgId} and table_name='payment_bank_profiles' order by id
      `,
            "objects",
          ),
        }));
      const before = await state();
      assert.equal(
        before.profiles.find((profile) => profile.id === created.id)?.name,
        "Standalone revised",
      );
      assert.equal(before.audit.length, 2);

      await assert.rejects(
        withOrgTransaction(org.orgId, async () => {
          await updatePaymentBankProfile(created.id, org.orgId, actorId, {
            name: "Rolled-back revision",
          });
          await createPaymentBankProfile(org.orgId, actorId, {
            ...input,
            name: "Rolled-back profile",
          });
          throw new Error("Caller cancelled the atomic unit");
        }),
        /Caller cancelled the atomic unit/,
      );
      assert.deepEqual(
        await state(),
        before,
        "profile and audit writes belong to the caller rollback",
      );

      await assert.rejects(
        withOrgTransaction(other.orgId, () => createPaymentBankProfile(org.orgId, actorId, input)),
        /cannot change organization inside an active tenant transaction/,
      );
      await assert.rejects(
        withBypass(() => createPaymentBankProfile(org.orgId, actorId, input)),
        /current organization's pinned transaction executor/,
      );
      await assert.rejects(createPaymentBankProfile(org.orgId, deniedId, input));
      assert.deepEqual(
        await state(),
        before,
        "scope and permission refusals preserve all bank profiles and audit rows",
      );
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
