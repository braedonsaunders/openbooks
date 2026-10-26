import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import {
  addSubcontractSovLine,
  createSubcontract,
  createSubcontractPaymentControl,
  SubcontractError,
} from "./subcontracts.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "createSubcontract refuses an inactive vendor party even when its vendor role is active",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Inactive vendor controller", "admin");
      const projectId = randomUUID();
      await db.execute(sql`
      update orgs
      set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"projects":true,"subcontracts":true}'::jsonb)
      where id = ${org.orgId}
    `);
      await db.execute(sql`
      insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'SVA', 'Inactive vendor project', ${org.customerId}, 'active')
    `);
      await db.execute(sql`
      insert into vendor_roles(org_id, party_id, is_active)
      values (${org.orgId}, ${org.vendorId}, true)
    `);
      await db.execute(sql`
      update parties set is_active = false where org_id = ${org.orgId} and id = ${org.vendorId}
    `);

      await assert.rejects(
        createSubcontract({
          orgId: org.orgId,
          userId: actor,
          projectId,
          vendorId: org.vendorId,
          number: "SVA-1",
          title: "Inactive vendor subcontract",
          originalCommitment: "1000",
        }),
        (error: unknown) =>
          error instanceof SubcontractError &&
          error.message === "Vendor is not active in this organization",
      );
      assert.equal(
        (
          await db.execute(
            sql`select count(*)::int as count from subcontracts where org_id = ${org.orgId}`,
            "objects",
          )
        )[0]?.count,
        0,
        "an inactive vendor must not create a subcontract",
      );
      assert.equal(
        (
          await db.execute(
            sql`select count(*)::int as count from audit_log where org_id = ${org.orgId}`,
            "objects",
          )
        )[0]?.count,
        0,
        "a rejected subcontract must not write audit evidence",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "subcontract inputs enforce currency and subsidiary availability in the service",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Scoped subcontract controller", "admin");
      const projectId = randomUUID();
      const branchId = randomUUID();
      const subcontractId = randomUUID();
      const payeeId = randomUUID();
      const currencyVendorId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
        update orgs
        set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
          || '{"projects":true,"subcontracts":true,"multiCurrency":false}'::jsonb)
        where id = ${org.orgId}
      `);
        await db.execute(sql`
        insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Separate vendor entity', 'CAD', 'CA')
      `);
        await db.execute(sql`
        insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'SVC', 'Scoped subcontract project', ${org.customerId}, 'active')
      `);
        await db.execute(sql`
        update app_roles
           set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
         where org_id = ${org.orgId} and key = 'admin'
      `);
        await db.execute(sql`
        insert into vendor_roles(org_id, party_id, is_active, currency)
        values (${org.orgId}, ${org.vendorId}, true, 'USD')
        on conflict (party_id) do update set is_active = true, currency = excluded.currency
      `);
        await db.execute(sql`
        insert into parties(id, org_id, kind, display_name, is_active)
        values (${currencyVendorId}, ${org.orgId}, 'vendor', 'Org-wide currency vendor', true)
      `);
        await db.execute(sql`
        insert into vendor_roles(org_id, party_id, is_active, currency)
        values (${org.orgId}, ${currencyVendorId}, true, 'USD')
      `);
        await db.execute(sql`
        insert into subcontracts(id, org_id, project_id, vendor_id, number, title, currency, original_commitment, status)
        values (${subcontractId}, ${org.orgId}, ${projectId}, ${org.vendorId}, 'SC-SCOPE', 'Scoped subcontract', 'CAD', '1000', 'draft')
      `);
        await db.execute(sql`
        update parties set subsidiary_id = ${branchId} where org_id = ${org.orgId} and id = ${org.vendorId}
      `);
        await db.execute(sql`
        insert into parties(id, org_id, kind, display_name, is_active, subsidiary_id)
        values (${payeeId}, ${org.orgId}, 'vendor', 'Separate entity joint payee', true, ${branchId})
      `);
        await db.execute(sql`
        update accounts set subsidiary_id = ${branchId}, subsidiary_include_children = false
         where org_id = ${org.orgId} and id = ${org.accounts.cogs}
      `);
      });

      await assert.rejects(
        createSubcontract({
          orgId: org.orgId,
          userId: actor,
          projectId,
          vendorId: org.vendorId,
          number: "SC-SCOPE-1",
          title: "Unscoped vendor subcontract",
          originalCommitment: "1000",
        }),
        /available to the project's subsidiary/,
      );
      await assert.rejects(
        createSubcontract({
          orgId: org.orgId,
          userId: actor,
          projectId,
          vendorId: currencyVendorId,
          number: "SC-CURRENCY-1",
          title: "Unsupported subcontract currency",
          currency: "ZZZ",
          originalCommitment: "1000",
        }),
        /not in the currency registry/,
      );
      await assert.rejects(
        createSubcontract({
          orgId: org.orgId,
          userId: actor,
          projectId,
          vendorId: currencyVendorId,
          number: "SC-MULTICURRENCY-1",
          title: "Foreign default subcontract currency",
          originalCommitment: "1000",
        }),
        /Multi-currency is disabled/,
      );
      await assert.rejects(
        addSubcontractSovLine({
          orgId: org.orgId,
          userId: actor,
          subcontractId,
          description: "Cross-entity expense",
          scheduledValue: "100",
          expenseAccountId: org.accounts.cogs,
        }),
        /not available to the project's subsidiary/,
      );
      await assert.rejects(
        createSubcontractPaymentControl({
          orgId: org.orgId,
          userId: actor,
          subcontractId,
          controlType: "joint_check",
          jointPayeePartyId: payeeId,
          reason: "Payee belongs to another legal entity",
          effectiveOn: "2000-01-01",
        }),
        /joint payee available to the project's subsidiary/,
      );
      assert.equal(
        (
          await db.execute(
            sql`select count(*)::int as count from subcontracts where org_id = ${org.orgId} and number <> 'SC-SCOPE'`,
            "objects",
          )
        )[0]?.count,
        0,
        "refused subcontract writes must leave no records",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
