import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { importNetSuiteCrm } from "./netsuite-crm.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Same-source CRM import in two tenants, with the NetSuite network canned.
 *
 * Both orgs import the identical source customer (NS-CUST-1) and the
 * identical source note: the profile upsert keys on party_id and the
 * activity upsert keys on the stable per-org id, each pinning the tenant
 * on the conflict write. Re-importing the first org must update its rows
 * through the conflict branches (no duplicates, ids stable) while the
 * second org lands its own rows. A bare org_id in either guard is
 * ambiguous (42702) and the re-import fails.
 */
test(
  "the same NetSuite source imports into two tenants without sharing rows",
  { skip: !DB, timeout: 180_000 },
  async () => {
    let customerStage = "customer";
    const transport: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.includes("/query/v1/suiteql")) {
        const query = String(
          (typeof init?.body === "string" ? (JSON.parse(init.body) as { q?: unknown }).q : undefined) ?? "",
        );
        let items: Record<string, unknown>[] = [];
        if (query.includes("from entitystatus")) {
          items = [{ key: "17", name: "Customer", entitytype: "CUSTOMER" }];
        } else if (query.includes("from customer")) {
          items = [{ id: "NS-CUST-1", stage: customerStage, entitystatus: "17", datecreated: "01/15/2026" }];
        } else if (query.includes("from transaction where type='Opprtnty'")) {
          items = [{
            id: "NS-OPP-1",
            tranid: "OPP-17",
            entity: "NS-CUST-1",
            probability: "37",
            currency: "CAD",
            foreigntotal: "100.01",
            memo: "Hydraulic press",
          }];
        } else if (query.includes("from recentactivity")) {
          items = [{
            id: "1845",
            entity: "NS-CUST-1",
            type: "Note : 9",
            typecode: "Note : 9",
            createddate: "05/03/2024",
            details: "Note - 2024-05-03 09:30am",
            subdetails: "Meeting at the plant. Went on a site tour and left rate sheets.",
          }];
        }
        return Response.json({ items, hasMore: false });
      }
      if (target.includes("/record/v1/")) {
        return Response.json({ items: [], hasMore: false });
      }
      throw new Error(`unstubbed NetSuite URL ${target}`);
    };

    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    try {
      const parties: Record<string, string> = {};
      for (const [org, label] of [[orgA, "Tenant A"], [orgB, "Tenant B"]] as const) {
        await createScratchUser(org.orgId, `CRM Importer ${label}`, "admin");
        await db.execute(sql`
          update orgs
             set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
                   coalesce(settings -> 'features', '{}'::jsonb) || '{"crm": true}'::jsonb)
           where id = ${org.orgId}`);
        const partyId = (
          await db.execute<{ id: string }>(sql`
            insert into parties (org_id, kind, display_name, is_active, custom)
            values (${org.orgId}, 'company', ${`Source Customer ${label}`}, true,
                    '{"nsId": "NS-CUST-1"}'::jsonb)
            returning id`)
        ).rows[0]!.id;
        parties[org.orgId] = partyId;
        await db.execute(sql`
          insert into connections (org_id, source, display_name, status, config, secrets)
          values (${org.orgId}, 'netsuite', ${`NetSuite ${label}`}, 'active',
                  '{"account": "123456", "host": "https://123456.suitetalk.api.netsuite.com"}'::jsonb,
                  ${sealJson({ consumerKey: "ck", consumerSecret: "cs", tokenKey: "tk", tokenSecret: "ts" })})`);
      }

      const first = await importNetSuiteCrm(orgA.orgId, undefined, transport);
      assert.equal(first.accounts, 1);
      assert.equal(first.opportunities, 1);
      assert.equal(first.activities.recentActivityNote, 1);
      const again = await importNetSuiteCrm(orgA.orgId, undefined, transport);
      assert.equal(again.accounts, 1);
      assert.equal(again.opportunities, 1);
      assert.equal(again.activities.recentActivityNote, 1);
      customerStage = "prospect";
      await Promise.all([
        importNetSuiteCrm(orgA.orgId, undefined, transport),
        importNetSuiteCrm(orgA.orgId, undefined, transport),
      ]);
      customerStage = "customer";
      const other = await importNetSuiteCrm(orgB.orgId, undefined, transport);
      assert.equal(other.accounts, 1);
      assert.equal(other.opportunities, 1);

      const profiles = await db.execute<{ orgId: string; partyId: string; stage: string }>(sql`
        select org_id as "orgId", party_id as "partyId", lifecycle_stage as stage
          from crm_account_profiles`);
      assert.deepEqual(
        profiles.rows.sort((a, b) => a.orgId.localeCompare(b.orgId)),
        [
          { orgId: orgA.orgId, partyId: parties[orgA.orgId], stage: "prospect" },
          { orgId: orgB.orgId, partyId: parties[orgB.orgId], stage: "customer" },
        ].sort((a, b) => a.orgId.localeCompare(b.orgId)),
      );

      const transition = await db.execute<{ fromStage: string | null; toStage: string }>(sql`
        select e.from_stage as "fromStage", e.to_stage as "toStage"
          from crm_account_stage_events e
          join crm_account_profiles p on p.id = e.account_profile_id and p.org_id = e.org_id
         where e.org_id = ${orgA.orgId} and p.party_id = ${parties[orgA.orgId]}
           and e.to_stage = 'prospect' and e.source_kind = 'import'`);
      assert.deepEqual(transition.rows, [{ fromStage: "customer", toStage: "prospect" }]);

      const opportunities = await db.execute<{
        orgId: string;
        probability: number;
        currency: string;
        projectedAmount: string;
        weightedAmount: string;
      }>(sql`
        select org_id as "orgId", probability, currency,
               projected_amount::text as "projectedAmount",
               weighted_amount::text as "weightedAmount"
          from crm_opportunities
         where custom -> 'netsuite' ->> 'id' = 'NS-OPP-1'`);
      assert.deepEqual(
        opportunities.rows.sort((a, b) => a.orgId.localeCompare(b.orgId)),
        [
          { orgId: orgA.orgId, probability: 37, currency: "CAD", projectedAmount: "100.0100", weightedAmount: "37.0037" },
          { orgId: orgB.orgId, probability: 37, currency: "CAD", projectedAmount: "100.0100", weightedAmount: "37.0037" },
        ].sort((a, b) => a.orgId.localeCompare(b.orgId)),
      );

      const activities = await db.execute<{ orgId: string; id: string; subject: string }>(sql`
        select org_id as "orgId", id, subject from crm_activities
         where custom -> 'netsuite' ->> 'recordType' = 'recentActivityNote'`);
      assert.equal(activities.rows.length, 2);
      const byOrg = new Map(activities.rows.map((row) => [row.orgId, row]));
      assert.notEqual(byOrg.get(orgA.orgId)!.id, byOrg.get(orgB.orgId)!.id);
      assert.match(byOrg.get(orgA.orgId)!.subject, /site tour/);

      const links = await db.execute<{ orgId: string; n: number }>(sql`
        select org_id as "orgId", count(*)::int as n from crm_activity_links
         group by org_id`);
      assert.deepEqual(
        links.rows.sort((a, b) => a.orgId.localeCompare(b.orgId)),
        [
          { orgId: orgA.orgId, n: 1 },
          { orgId: orgB.orgId, n: 1 },
        ].sort((a, b) => a.orgId.localeCompare(b.orgId)),
      );
    } finally {
      await dropScratchOrg(orgB.orgId);
      await dropScratchOrg(orgA.orgId);
    }
  },
);
