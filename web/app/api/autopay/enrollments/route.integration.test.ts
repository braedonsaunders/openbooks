import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { resolveAuthzByUserId } from "@/lib/authz-core";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { withAuthzContext as withRequestAuthz } from "@/lib/authz-context";
import { GET } from "./route";

test(
  "enrollment reads expose the linked plan name",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Autopay reader", "autopay-reader"),
      );
      const planId = randomUUID();
      const subscriptionId = randomUUID();
      const enrollmentId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`update app_roles set permissions='["payment_methods.read"]'::jsonb where org_id=${org.orgId} and key='autopay-reader'`,
        );
        await db.execute(
          sql`update orgs set settings=settings || jsonb_build_object('features', coalesce(settings->'features','{}'::jsonb) || '{"onlinePayments":true,"autopay":true}'::jsonb) where id=${org.orgId}`,
        );
        await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, interval, interval_count, income_account_id, is_active, created_by)
        values (${planId}, ${org.orgId}, 'Support Plan', '25.00', 'CAD', 'monthly', 1, ${org.accounts.revenue}, true, ${actorId})`);
        await db.execute(sql`insert into subscriptions (id, org_id, customer_id, plan_id, start_on, next_bill_on, created_by)
        values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '2026-01-01', '2026-11-01', ${actorId})`);
        await db.execute(sql`insert into autopay_enrollments (id, org_id, party_id, subscription_id, status, created_by)
        values (${enrollmentId}, ${org.orgId}, ${org.customerId}, ${subscriptionId}, 'active', ${actorId})`);
      });

      const response = await withOrgContext(org.orgId, async () => {
        const authz = await resolveAuthzByUserId(org.orgId, actorId);
        assert.ok(authz);
        return withRequestAuthz(authz, () =>
          GET(new Request(`http://autopay.test/api/autopay/enrollments?partyId=${org.customerId}`)),
        );
      });
      assert.equal(response.status, 200, await response.clone().text());
      const payload = (await response.json()) as {
        enrollments: Array<{ id: string; subscriptionName: string }>;
      };
      assert.deepEqual(
        payload.enrollments.map(({ id, subscriptionName }) => ({ id, subscriptionName })),
        [{ id: enrollmentId, subscriptionName: "Support Plan" }],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
