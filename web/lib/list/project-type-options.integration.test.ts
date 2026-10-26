import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { stubModules } from "../../testing/stub-modules.ts";

// The projects list rendered a custom type's key ("t11 tm
// verify") instead of its name ("T11 T&M Verify") because the billing
// filter only knew the three static built-ins. The filter now loads tenant
// types (key as value, name as label) so cells and the dropdown resolve
// them; built-ins keep their static translated options. Needs a fixture
// database.
stubModules({
  intl: true,
  navigation: { pathname: "/projects" },
  authz: false,
  features: false,
  extra: {
    "next-intl":
      "export function useTranslations(){const t=(key)=>key;t.rich=(key)=>key;return t}export function useLocale(){return 'en'}export function useTimeZone(){return 'UTC'}",
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { installTrustedTestDatabaseBypass } =
  await import("@openbooks/engine/testing/database-bypass");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { entityListSource } = await import("./entity-sources.ts");
const { EntityListView } = await import("../../components/entity-list-view.tsx");
const { defaultListView } = await import("@openbooks/customization");

installTrustedTestDatabaseBypass();

const DB = !!process.env.OPENBOOKS_DB_URL;

test("the billing filter loads custom type names", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const billing = entityListSource("project")?.quickFilters?.find(
      (filter) => filter.filterKey === "project_type",
    );
    assert.ok(billing?.loadOptions, "the billing filter carries a tenant type loader");
    const builtinTm = BUILTIN_PROJECT_TYPES.find((type) => type.key === "time_and_materials")!;
    await db.execute(sql`
      insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
      values (${randomUUID()}, ${org.orgId}, 't11_tm_verify', 'T11 T&M Verify', 'time_and_materials',
              ${JSON.stringify(builtinTm.invoicingProfile)}::jsonb,
              ${JSON.stringify(builtinTm.backupProfile)}::jsonb)`);
    const options = await billing.loadOptions(org.orgId, null);
    const custom = options.find((option) => option.value === "t11_tm_verify");
    assert.equal(custom?.label, "T11 T&M Verify", "the custom key resolves to its name");
    const values = options.map((option) => option.value);
    assert.equal(new Set(values).size, values.length, "loader values stay unique for the merge");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the project list displays a tenant-defined type by its name", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const userId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Project list reader", "reviewer"),
    );
    await withBypassContext(async () => {
      await db.execute(
        sql`update app_roles set permissions='["*"]'::jsonb where org_id = ${org.orgId} and key = 'reviewer'`,
      );
      await db.execute(
        sql`update orgs set settings = settings || ${JSON.stringify({ features: { projects: true } })}::jsonb where id = ${org.orgId}`,
      );
      const builtinTm = BUILTIN_PROJECT_TYPES.find((type) => type.key === "time_and_materials")!;
      const typeId = randomUUID();
      await db.execute(sql`
        insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
        values (${typeId}, ${org.orgId}, 't11_tm_rendered', 'T11 T&M Rendered', 'time_and_materials',
                ${JSON.stringify(builtinTm.invoicingProfile)}::jsonb,
                ${JSON.stringify(builtinTm.backupProfile)}::jsonb)`);
      await db.execute(sql`
        insert into projects (org_id, name, project_type_id)
        values (${org.orgId}, 'List display fixture', ${typeId})`);
    });

    const element = await withOrgContext(org.orgId, () =>
      EntityListView({
        recordType: "project",
        orgId: org.orgId,
        userId,
        canManage: true,
        sp: { billing: "t11_tm_rendered" },
      }),
    );
    const markup = renderToStaticMarkup(element);
    const displayOccurrences = markup.match(/T11 T&amp;M Rendered|T11 T&M Rendered/g) ?? [];
    assert.ok(
      displayOccurrences.length >= 2,
      "the selected billing filter and project row both show the tenant-defined name",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "the Projects page loads a stored billing-method view without rewriting it",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const userId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Project view reader", "reviewer"),
      );
      const viewId = randomUUID();
      const config = {
        ...defaultListView("project"),
        columns: [
          "name",
          "code",
          "customer",
          "status",
          "billing_method",
          "contract",
          "actual",
          "created",
          "_actions",
        ].map((key) => ({
          key,
          visible: true,
          ...(key === "billing_method"
            ? { labelOverride: "Saved billing classification", width: 172 }
            : {}),
        })),
        sort: { column: "billing_method", dir: "asc" as const },
        filters: [{ key: "billing_method", operator: "eq" as const, value: "fixed_price" }],
      };
      await withBypassContext(async () => {
        await db.execute(
          sql`update app_roles set permissions='["projects.read","gl.read"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
        );
        await db.execute(
          sql`update orgs set settings=settings||'{"features":{"projects":true}}'::jsonb where id=${org.orgId}`,
        );
        const fixed = BUILTIN_PROJECT_TYPES.find((type) => type.key === "fixed_price")!,
          typeId = randomUUID();
        await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values(${typeId},${org.orgId},'service_agreement','Service agreement','fixed_price',
          ${JSON.stringify(fixed.invoicingProfile)}::jsonb,${JSON.stringify(fixed.backupProfile)}::jsonb)`);
        await db.execute(sql`insert into projects(org_id,subsidiary_id,name,project_type_id)
        values(${org.orgId},${org.subsidiaryId},'Stored view project',${typeId})`);
        await db.execute(sql`insert into list_views(id,org_id,record_type,name,scope,is_default,config,created_by,updated_by)
        values(${viewId},${org.orgId},'project','Saved billing view','org',false,${JSON.stringify(config)}::jsonb,${userId},${userId})`);
      });
      const before = await withOrgContext(org.orgId, () =>
        db.execute(
          sql`select config,updated_at::text from list_views where org_id=${org.orgId} and id=${viewId}`,
          "objects",
        ),
      );
      const element = await withOrgContext(org.orgId, () =>
        EntityListView({
          recordType: "project",
          orgId: org.orgId,
          userId,
          canManage: false,
          sp: { view: viewId },
        }),
      );
      const markup = renderToStaticMarkup(element);
      assert.match(markup, /Stored view project/);
      assert.match(markup, /Saved billing classification/);
      assert.doesNotMatch(markup, /unknown column/);
      const after = await withOrgContext(org.orgId, () =>
        db.execute(
          sql`select config,updated_at::text from list_views where org_id=${org.orgId} and id=${viewId}`,
          "objects",
        ),
      );
      assert.deepEqual(after, before, "a read preserves the stored view and its revision");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
