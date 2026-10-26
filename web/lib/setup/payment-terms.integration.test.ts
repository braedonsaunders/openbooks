import assert from "node:assert/strict";
import test from "node:test";
const { db, env, withBypass } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { resolveCompanyTermsDueDate } = await import("@openbooks/engine/ledger/document-defaults");
const { createSetupRecord, updateSetupRecord } = await import("./write.ts");

async function adminOrg() {
  const org = await withBypass(() => createScratchOrg());
  const actor = await withBypass(() => createScratchUser(org.orgId, "Setup Admin", "admin"));
  await withBypass(() =>
    db.execute(
      sql`update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'admin'`,
    ),
  );
  return {
    org,
    asAdmin: {
      orgId: org.orgId,
      id: actor as unknown as string,
      permissions: ["*"] as Iterable<string>,
    },
  };
}

const errorOf = (result: { body: unknown }) =>
  String((result.body as { error?: string }).error ?? "");

test(
  "payment terms save a due day of month that document due dates follow",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, asAdmin } = await adminOrg();
    try {
      const created = await withBypass(() =>
        createSetupRecord(asAdmin, "payment-terms", {
          name: "Net 30, 1st following",
          netDays: 30,
          dueDayOfMonth: 1,
          isActive: true,
        }),
      );
      assert.equal(created.status, 200);
      const id = String((created.body as { id?: string }).id);
      await withBypass(() =>
        db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('billing', jsonb_build_object('defaultPaymentTermsId', ${id}::text))
       where id = ${org.orgId}`),
      );
      const dueOn = (date: string) =>
        withBypass(() => resolveCompanyTermsDueDate(db, org.orgId, date));
      assert.equal((await dueOn("2026-10-22"))?.dueDate, "2026-12-01");

      for (const [patch, message] of [
        [{ dueDayOfMonth: 32 }, /dueDayOfMonth must be at most 31/],
        [{ dueDayOfMonth: 0 }, /dueDayOfMonth must be at least 1/],
        [{ netDays: -1 }, /netDays must be at least 0/],
      ] as const) {
        const refused = await withBypass(() =>
          updateSetupRecord(asAdmin, "payment-terms", { id, ...patch }),
        );
        assert.notEqual(refused.status, 200, JSON.stringify(patch));
        assert.match(errorOf(refused), message);
      }
      assert.equal((await dueOn("2026-10-22"))?.dueDate, "2026-12-01");

      // Clearing the day returns the terms to counting net days only.
      const cleared = await withBypass(() =>
        updateSetupRecord(asAdmin, "payment-terms", { id, dueDayOfMonth: "" }),
      );
      assert.equal(cleared.status, 200);
      assert.equal((await dueOn("2026-10-22"))?.dueDate, "2026-11-21");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
