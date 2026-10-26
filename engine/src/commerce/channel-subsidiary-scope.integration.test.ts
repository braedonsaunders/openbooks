import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { addCalendarDays } from "../platform/civil-date.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { CommerceError } from "./errors.ts";
import { linkExternal } from "./external-links.ts";
import { upsertChannelLocation } from "./locations.ts";
import { setPostingPolicy } from "./posting-policies.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function setupChannel() {
  const org = await withBypass(() => createScratchOrg());
  const actor = await withBypass(() =>
    createScratchUser(org.orgId, "Channel scope tester", "admin"),
  );
  const subB = randomUUID();
  const channelId = randomUUID();
  await withBypass(async () => {
    await db.execute(
      sql`update orgs set settings = settings || '{"features":{"salesChannels":true}}'::jsonb where id = ${org.orgId}`,
    );
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA')`);
    await db.execute(
      sql`update locations set subsidiary_id = ${org.subsidiaryId} where org_id = ${org.orgId} and id = ${org.locationId}`,
    );
    await db.execute(sql`update locations set subsidiary_id = ${subB} where org_id = ${org.orgId}
      and id = (select location_id from stock_locations where org_id = ${org.orgId} and id = ${org.stockLocationId2})`);
    await db.execute(
      sql`update parties set subsidiary_id = null where org_id = ${org.orgId} and id = ${org.customerId}`,
    );
    await db.execute(
      sql`insert into customer_roles (org_id, party_id, is_active) values (${org.orgId}, ${org.customerId}, true)`,
    );
    await db.execute(sql`
      insert into sales_channels (id, org_id, kind, name, status, subsidiary_id, currency, external_account, settings, created_by, updated_by)
      values (${channelId}, ${org.orgId}, 'shopify', 'Home shop', 'active', ${org.subsidiaryId}, 'CAD', 'home.myshopify.com', '{}'::jsonb, ${actor}, ${actor})`);
  });
  return { org, actor, subB, channelId };
}

test(
  "channel stock and external mappings stay with the channel subsidiary",
  { skip: !DB },
  async () => {
    const { org, actor, subB, channelId } = await setupChannel();
    try {
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          upsertChannelLocation(org.orgId, actor, {
            channelId,
            allowedSubsidiaryIds: new Set([org.subsidiaryId]),
            externalLocationId: "home-warehouse",
            externalName: "Home warehouse",
            stockLocationId: org.stockLocationId2,
          }),
        ),
        (error: unknown) =>
          error instanceof CommerceError && error.code === "channel_location_stock_unavailable",
      );

      await withOrgContext(org.orgId, () =>
        upsertChannelLocation(org.orgId, actor, {
          channelId,
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
          externalLocationId: "home-warehouse",
          externalName: "Home warehouse",
          stockLocationId: org.stockLocationId,
        }),
      );

      const documentId = randomUUID();
      await withBypass(() =>
        db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', 'CH-SCOPE-B', ${subB}, ${org.customerId},
              ${org.date}, ${org.date}, 'CAD', '1', '10', '0', '10', ${actor})`),
      );

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          linkExternal(
            org.orgId,
            actor,
            {
              channelId,
              allowedSubsidiaryIds: new Set([org.subsidiaryId]),
              provider: "shopify",
              externalAccount: "home.myshopify.com",
              objectType: "order",
              externalId: "cross-entity-order",
              nativeTable: "documents",
              nativeId: documentId,
            },
            "salesChannels",
          ),
        ),
        (error: unknown) =>
          error instanceof CommerceError && error.code === "external_link_target_out_of_scope",
      );
      const linkCount = (
        await withBypass(() =>
          db.execute<{ n: number }>(
            sql`
      select count(*)::integer as n from external_links where org_id = ${org.orgId} and external_id = 'cross-entity-order'`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(linkCount, 0, "a cross-entity link is not persisted");
    } finally {
      await withBypass(() => dropScratchOrgReporting(org.orgId));
    }
  },
);

test(
  "walk-in customers match the channel entity and policy audit closes the prior day",
  { skip: !DB },
  async () => {
    const { org, actor, subB, channelId } = await setupChannel();
    try {
      const otherCustomerId = randomUUID();
      await withBypass(async () => {
        await db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
        values (${otherCustomerId}, ${org.orgId}, 'company', 'Other entity customer', true, ${subB}, '{}'::jsonb)`);
        await db.execute(
          sql`insert into customer_roles (org_id, party_id, is_active) values (${org.orgId}, ${otherCustomerId}, true)`,
        );
      });
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          setPostingPolicy(org.orgId, actor, {
            channelId,
            allowedSubsidiaryIds: new Set([org.subsidiaryId]),
            mode: "per_order",
            guestCustomerPartyId: otherCustomerId,
            effectiveFrom: org.date,
          }),
        ),
        (error: unknown) =>
          error instanceof CommerceError && error.code === "channel_policy_guest_unavailable",
      );

      const first = await withOrgContext(org.orgId, () =>
        setPostingPolicy(org.orgId, actor, {
          channelId,
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
          mode: "per_order",
          guestCustomerPartyId: org.customerId,
          effectiveFrom: org.date,
        }),
      );
      const nextDate = addCalendarDays(org.date, 1);
      await withOrgContext(org.orgId, () =>
        setPostingPolicy(org.orgId, actor, {
          channelId,
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
          mode: "daily_summary",
          effectiveFrom: nextDate,
        }),
      );
      const audit = (
        await withBypass(() =>
          db.execute<{ effective_to: string }>(
            sql`
      select changes #>> '{after,effectiveTo}' as effective_to from audit_log
       where org_id = ${org.orgId} and table_name = 'sales_channel_posting_policies'
         and row_id = ${first.id} and action = 'update'`,
            "objects",
          ),
        )
      )[0];
      assert.equal(audit?.effective_to, org.date);
    } finally {
      await withBypass(() => dropScratchOrgReporting(org.orgId));
    }
  },
);
