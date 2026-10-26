import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { resolveUserAuthz } from "./authz-core";
import type { SessionUser } from "./auth";

test(
  "live authorization sees tenant identity, permissions and subsidiary scope from one uncommitted transaction",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Scoped operator", "poster");
      const user = { id: actor, orgId: org.orgId, isSuperAdmin: false } as SessionUser;
      const initial = await resolveUserAuthz(user);
      const rollback = new Error("rollback scope fixture");
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          db.transaction(async (tx) => {
            const changed = await tx.execute(
              sql`update app_roles set permissions='["reports.read"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
        where org_id=${org.orgId} and key='poster' returning id`,
              "objects",
            );
            assert.equal(changed.length, 1);
            const actual = await resolveUserAuthz(user, tx);
            assert.ok(actual.permissions.has("reports.read"));
            assert.deepEqual(actual.allowedSubsidiaryIds, new Set([org.subsidiaryId]));
            const inactive = await tx.execute(
              sql`update users set is_active=false where org_id=${org.orgId} and id=${actor} returning id`,
              "objects",
            );
            assert.equal(inactive.length, 1);
            assert.deepEqual((await resolveUserAuthz(user, tx)).allowedSubsidiaryIds, new Set());
            throw rollback;
          }),
        ),
        (e) => e === rollback,
      );
      assert.deepEqual(
        (await resolveUserAuthz(user)).allowedSubsidiaryIds,
        initial.allowedSubsidiaryIds,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
