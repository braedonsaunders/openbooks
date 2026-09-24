import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { pathToFileURL } from "node:url";
import test from "node:test";

// F-t11-003: the projects list rendered a custom type's key ("t11 tm
// verify") instead of its name ("T11 T&M Verify") because the billing
// filter only knew the three static built-ins. The filter now loads tenant
// types (key as value, name as label) so cells and the dropdown resolve
// them; built-ins keep their static translated options. Needs a fixture
// database.
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export async function getTranslations(){return (key)=>key}export async function getLocale(){return 'en'}" };
    }
    if (specifier === "next-intl") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export function useTranslations(){const t=(key)=>key;t.rich=(key)=>key;return t}" };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export function useRouter(){return {push(){},replace(){},refresh(){}}}export function usePathname(){return '/projects'}export function useSearchParams(){return new URLSearchParams()}" };
    }
    if (specifier.startsWith('@/')) return nextResolve(root + 'web/' + specifier.slice(2) + '.ts', context);
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { installTrustedTestDatabaseBypass } = await import("@openbooks/engine/src/testing/database-bypass.ts");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { entityListSource } = await import("./entity-sources.ts");
const { EntityListView } = await import("../../components/entity-list-view.tsx");

installTrustedTestDatabaseBypass();

const DB = !!process.env.OPENBOOKS_DB_URL;

test("the billing filter loads custom type names", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const billing = entityListSource("project")?.quickFilters?.find((filter) => filter.filterKey === "project_type");
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
    const userId = await withBypassContext(() => createScratchUser(org.orgId, "Project list reader", "reviewer"));
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id = ${org.orgId} and key = 'reviewer'`);
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ features: { projects: true } })}::jsonb where id = ${org.orgId}`);
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

    const element = await withOrgContext(org.orgId, () => EntityListView({
      recordType: "project", orgId: org.orgId, userId, canManage: true, sp: { billing: "t11_tm_rendered" },
    }));
    const markup = renderToStaticMarkup(element);
    const displayOccurrences = markup.match(/T11 T&amp;M Rendered|T11 T&M Rendered/g) ?? [];
    assert.ok(displayOccurrences.length >= 2, "the selected billing filter and project row both show the tenant-defined name");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
