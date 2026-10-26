import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { packSlotState } from "./packs.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "statutory liability slots resolve only from native component accounts, never organization settings keys",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await seedPayrollComponents(org.orgId, actor, "CA");
      const explicit = await seedPostingAccount(
        org.orgId,
        "2380",
        "Native statutory liability",
        "liability_current_other",
      );
      const settingsOnly = await seedPostingAccount(
        org.orgId,
        "2381",
        "Settings-only CPP liability",
        "liability_current_other",
      );
      await db.execute(
        sql`update pay_components set liability_account_id=${explicit} where org_id=${org.orgId} and country='CA'`,
      );
      await db.execute(sql`update pay_components set liability_account_id=null
      where org_id=${org.orgId} and country='CA' and system_key='cpp' and kind='deduction'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll}',${JSON.stringify({ cppPayableAccountId: settingsOnly })}::jsonb)
      where id=${org.orgId}`);
      const slots =
        (await packSlotState(org.orgId, ["CA"])).find((pack) => pack.country === "CA")?.slots ?? [];
      assert.ok(
        slots.some((slot) => slot.accountId === explicit),
        "a fully mapped slot resolves to its native component account",
      );
      assert.equal(
        slots.find((slot) => slot.key === "cpp")?.accountId,
        null,
        "an organization settings key cannot satisfy a missing native component mapping",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
