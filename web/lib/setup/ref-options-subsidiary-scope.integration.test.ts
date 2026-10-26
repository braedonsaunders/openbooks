import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { db, env, withBypass } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");
const { SETUP_ENTITY_BY_KEY } = await import("./registry.ts");
const { loadAccounts, loadEntityOptions, loadRefOptions } = await import("./ref-options.ts");

test(
  "subsidiary-scoped reference pickers hide accounts and records owned by other subsidiaries",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actors = await withBypass(() => seedFlowActors(org.orgId));
      const subA = randomUUID(),
        subB = randomUUID();
      const accountA = randomUUID(),
        accountB = randomUUID(),
        accountGlobal = randomUUID(),
        accountTree = randomUUID();
      const customerA = randomUUID(),
        customerB = randomUUID(),
        channelA = randomUUID(),
        channelB = randomUUID();
      const projectA = randomUUID(),
        projectB = randomUUID(),
        settingA = randomUUID(),
        settingB = randomUUID();
      const root = org.subsidiaryId;

      await withBypass(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values
        (${subA},${org.orgId},${root},'Reference A','CAD','CA',true),
        (${subB},${org.orgId},${root},'Reference B','CAD','CA',true)`);
        await db.execute(sql`insert into accounts(id,org_id,number,name,type,subsidiary_id,subsidiary_include_children) values
        (${accountA},${org.orgId},'REF-A','A expense','expense',${subA},false),
        (${accountB},${org.orgId},'REF-B','B expense','expense',${subB},false),
        (${accountGlobal},${org.orgId},'REF-GLOBAL','Shared expense','expense',null,true),
        (${accountTree},${org.orgId},'REF-TREE','Root shared expense','expense',${root},true)`);
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values
        (${customerA},${org.orgId},'company','Customer A',${subA},true),
        (${customerB},${org.orgId},'company','Customer B',${subB},true)`);
        await db.execute(sql`insert into customer_roles(org_id,party_id,is_active) values
        (${org.orgId},${customerA},true),(${org.orgId},${customerB},true)`);
        await db.execute(sql`insert into sales_channels(id,org_id,kind,name,subsidiary_id,currency,external_account) values
        (${channelA},${org.orgId},'shopify','Channel A',${subA},'CAD',${`account-${channelA}`}),
        (${channelB},${org.orgId},'shopify','Channel B',${subB},'CAD',${`account-${channelB}`})`);
        await db.execute(sql`insert into projects(id,org_id,code,name,subsidiary_id) values
        (${projectA},${org.orgId},'REF-A','Project A',${subA}),
        (${projectB},${org.orgId},'REF-B','Project B',${subB})`);
        await db.execute(sql`insert into einvoice_settings(id,org_id,subsidiary_id,default_profile,created_by,updated_by) values
        (${settingA},${org.orgId},${subA},'en16931-ubl',${actors.submitterId},${actors.submitterId}),
        (${settingB},${org.orgId},${subB},'en16931-ubl',${actors.submitterId},${actors.submitterId})`);
      });

      const scope = new Set([subA]);
      const accounts = await withBypass(() => loadAccounts(org.orgId, scope));
      const accountValues = accounts.map((option) => option.value);
      assert.ok(accountValues.includes(accountA));
      assert.ok(accountValues.includes(accountGlobal), "unrestricted accounts remain available");
      assert.ok(
        accountValues.includes(accountTree),
        "a parent-restricted account admitting this child remains available",
      );
      assert.ok(
        !accountValues.includes(accountB),
        "an account restricted to another subsidiary is hidden",
      );

      const amortization = SETUP_ENTITY_BY_KEY.get("expense-amortization-templates");
      assert.ok(amortization);
      const refs = await withBypass(() => loadRefOptions(amortization, org.orgId, scope));
      const accountOptions = refs.accounts;
      assert.ok(accountOptions, "amortization templates expose account references");
      assert.ok(accountOptions.some((option) => option.value === accountA));
      assert.ok(
        !accountOptions.some((option) => option.value === accountB),
        "setup ref loading carries the same subsidiary scope",
      );

      const customers = await withBypass(() => loadEntityOptions("customers", org.orgId, scope));
      assert.ok(customers.some((option) => option.value === customerA));
      assert.ok(!customers.some((option) => option.value === customerB));
      const channels = await withBypass(() =>
        loadEntityOptions("sales-channels", org.orgId, scope),
      );
      assert.ok(channels.some((option) => option.value === channelA));
      assert.ok(!channels.some((option) => option.value === channelB));
      const projects = await withBypass(() => loadEntityOptions("projects", org.orgId, scope));
      assert.ok(projects.some((option) => option.value === projectA));
      assert.ok(!projects.some((option) => option.value === projectB));
      const einvoiceSettings = await withBypass(() =>
        loadEntityOptions("einvoice-settings", org.orgId, scope),
      );
      assert.ok(einvoiceSettings.some((option) => option.value === settingA));
      assert.ok(
        !einvoiceSettings.some((option) => option.value === settingB),
        "generic setup references use their declared subsidiary owner",
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "accounting-period references keep the id and label the period from its fiscal position",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      // The scratch period is stored as '2026-07'; the picker never shows that name.
      const fxRates = SETUP_ENTITY_BY_KEY.get("consolidated-fx-rates");
      assert.ok(fxRates);
      const viewer = await withBypass(() => loadRefOptions(fxRates, org.orgId, null, "en"));
      assert.deepEqual(viewer["accounting-periods"], [
        { value: org.periodId, label: "P07 FY2026 · Jul 2026" },
      ]);
      const localeFree = await withBypass(() =>
        loadEntityOptions("accounting-periods", org.orgId, null),
      );
      assert.deepEqual(localeFree, [{ value: org.periodId, label: "P07 FY2026" }]);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
