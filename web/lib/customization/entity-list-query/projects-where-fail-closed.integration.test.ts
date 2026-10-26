import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

// The project list interpolates the customer_id structured filter into a
// uuid column uncast: a crafted value (or a saved view holding one) dies as
// a raw throw and the whole page 500s. The builder must fail such filters
// closed to an empty row set. SQL builders and storage are real; only
// server-only is stubbed.
const { db, withBypassContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/testing/fixtures");
const { projectWhere, PROJECT_BUILT_IN_EXPR, PROJECT_SORTS } = await import("./projects.ts");
const { defaultListView } = await import("@openbooks/customization");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");

const DB = !!process.env.OPENBOOKS_DB_URL;

type Filter = { key: string; operator: string; value?: string | null; to?: string | null };

async function projectCount(orgId: string, viewFilters: Filter[] = []): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from projects p
      where ${projectWhere({ ...defaultListView("project"), filters: viewFilters as never }, {}, orgId, null)}`,
    "objects",
  );
  return rows[0]!.n;
}

test("malformed project filters match nothing instead of throwing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    assert.ok((await projectCount(org.orgId)) >= 0, "baseline counts without throwing");
    assert.equal(
      await projectCount(org.orgId, [{ key: "customer_id", operator: "eq", value: "not-a-uuid" }]),
      0,
      "malformed customer filter matches nothing",
    );
    assert.equal(
      await projectCount(org.orgId, [
        { key: "customer_id", operator: "eq", value: "00000000-0000-4000-8000-000000000000" },
      ]),
      0,
      "well-formed unknown customer stays empty without throwing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "saved billing classifications resolve custom types and keep entity scope",
  { skip: !DB },
  async () => {
    await withBypassContext(async () => {
      const org = await createScratchOrg();
      try {
        const fixed = BUILTIN_PROJECT_TYPES.find((type) => type.key === "fixed_price")!;
        const typeId = randomUUID(),
          other = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`);
        await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values(${typeId},${org.orgId},'tenant_service','Tenant service','fixed_price',
          ${JSON.stringify(fixed.invoicingProfile)}::jsonb,${JSON.stringify(fixed.backupProfile)}::jsonb)`);
        for (const [name, owner, type] of [
          ["Visible fixed", org.subsidiaryId, typeId],
          ["Visible unconfigured", org.subsidiaryId, null],
          ["Hidden fixed", other, typeId],
        ]) {
          await db.execute(sql`insert into projects(org_id,subsidiary_id,name,project_type_id)
          values(${org.orgId},${owner},${name},${type})`);
        }
        const view = {
          ...defaultListView("project"),
          filters: [{ key: "billing_method", operator: "eq" as const, value: "fixed_price" }],
        };
        const read = async (scope: Set<string>) =>
          await db.execute<{ name: string; method: string }>(
            sql`
        select p.name,${PROJECT_BUILT_IN_EXPR.billing_method!} as method from projects p
        where ${projectWhere(view, {}, org.orgId, scope)}
        order by ${PROJECT_SORTS.billing_method!},p.name`,
            "objects",
          );
        assert.deepEqual(await read(new Set([org.subsidiaryId])), [
          { name: "Visible fixed", method: "fixed_price" },
        ]);
        assert.deepEqual(await read(new Set()), []);
        const unfiltered = await db.execute<{ method: string }>(
          sql`
        select ${PROJECT_BUILT_IN_EXPR.billing_method!} as method from projects p
        where ${projectWhere({ ...view, filters: [] }, {}, org.orgId, new Set([org.subsidiaryId]))}
        order by ${PROJECT_SORTS.billing_method!},p.name`,
          "objects",
        );
        assert.deepEqual(
          unfiltered.map((row) => row.method),
          ["fixed_price", "time_and_materials"],
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });
  },
);
