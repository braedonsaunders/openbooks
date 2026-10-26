import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  seedPostingAccount,
} from "@openbooks/engine/testing/fixtures";
import { resolveAuthzByUserId } from "../../../../lib/authz-core";
import { withAuthzContext } from "../../../../lib/authz-context";
import { GET } from "./route";

test(
  "till preview enforces the real cashier entity scope before returning sales or drop counts",
  {
    skip: !process.env.OPENBOOKS_DB_URL,
  },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const branch = randomUUID();
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "Scoped cashier", "till-window-reader"),
      );
      const till = await withBypassContext(() =>
        seedPostingAccount(org.orgId, "1016", "Shared till", "asset_current_other", null),
      );
      await withBypassContext(async () => {
        await db.execute(sql`update app_roles set permissions='["cash_sales.deposit"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
        where org_id=${org.orgId} and key='till-window-reader'`);
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,cashSales}','true'::jsonb)
        where id=${org.orgId}`);
        await db.execute(sql`insert into subsidiaries(id,org_id,name,parent_id,base_currency,country,is_active,is_elimination,custom)
        values(${branch},${org.orgId},'Other cashier entity',${org.subsidiaryId},'CAD','CA',true,false,'{}'::jsonb)`);
        for (const [entity, amount] of [
          [org.subsidiaryId, "1200000"],
          [branch, "9000000"],
        ] as const) {
          const sale = randomUUID();
          await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,
          party_id,document_date,currency,fx_rate,subtotal,tax_total,total,custom)
          values(${sale},${org.orgId},'cash_sale','draft',${`CS-${sale}`},${entity},${org.customerId},
          '2026-07-10','CAD','1','0','0','0','{}'::jsonb)`);
          await db.execute(sql`insert into document_tenders(org_id,document_id,position,kind,method_label,
          account_id,amount_minor,currency) values(${org.orgId},${sale},1,'cash','cash',${till},${amount},'CAD')`);
        }
      });
      const read = (entity: string) =>
        withOrgContext(org.orgId, async () => {
          const authz = await resolveAuthzByUserId(org.orgId, actor);
          assert.ok(authz);
          return withAuthzContext(authz, () =>
            GET(
              new Request(
                `http://cash.local/api/cash-sales/till-drops?tillAccountId=${till}&date=2026-07-11&subsidiaryId=${entity}`,
              ),
            ),
          );
        });
      const allowed = await read(org.subsidiaryId);
      assert.equal(allowed.status, 200, await allowed.clone().text());
      const window = await allowed.json();
      assert.equal(window.subsidiaryId, org.subsidiaryId);
      assert.equal(window.salesCount, 1);
      assert.equal(window.tendered, "120.0000");
      const hidden = await read(branch);
      assert.equal(hidden.status, 404, await hidden.clone().text());
      await withBypassContext(() =>
        db.execute(sql`update app_roles set
      subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id=${org.orgId} and key='till-window-reader'`),
      );
      const empty = await read(org.subsidiaryId);
      assert.equal(empty.status, 404, await empty.clone().text());
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
