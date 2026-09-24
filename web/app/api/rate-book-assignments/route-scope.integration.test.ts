import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Labour rate-book assignments price the customer or project they hang
 * off, so a projects.manage holder restricted to one subsidiary must not
 * read, create, change, or delete assignments on another subsidiary's
 * records. Project scope is strict; customer parties scope under the
 * shared-party policy. Every denial answers the uniform not-found, so
 * probing ids never oracles what another entity holds.
 *
 * The gate's identity half is stubbed (controllable permissions/scope);
 * every scope predicate below it — guardSubsidiaryScope, the project
 * lock, the snapshot — is the real production code.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const fileRoot = root;
const state = {
  orgId: "",
  actorId: "",
  permissions: new Set<string>(["projects.read", "projects.manage"]),
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
Object.assign(globalThis, { __rateBookScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
    if (specifier.endsWith("/lib/authz"))
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__rateBookScopeState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(s.permissions),
            allowedSubsidiaryIds: s.allowedSubsidiaryIds,
          };
        }
        export { can, guardSubsidiaryScope } from '${fileRoot}web/lib/authz.ts';
      `);
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, POST, PATCH, DELETE } = await import("./route.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  state.orgId = org.orgId;
  state.actorId = actorId;
  await withBypassContext(() => db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,projects}', 'true'::jsonb, true)
     where id = ${org.orgId}`));
  const branchId = randomUUID();
  const custA = randomUUID();
  const custB = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Division B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${custA}, ${org.orgId}, 'customer', 'Customer A', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${custB}, ${org.orgId}, 'customer', 'Customer B', ${branchId}, true, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into customer_roles (org_id, party_id) values (${org.orgId}, ${custA}), (${org.orgId}, ${custB})`));
  await withBypassContext(() => db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projA}, ${org.orgId}, ${org.subsidiaryId}, 'RB-A', 'Rate project A', ${custA}, 'active', true, '{}'::jsonb),
           (${projB}, ${org.orgId}, ${branchId}, 'RB-B', 'Rate project B', ${custB}, 'active', true, '{}'::jsonb)`));
  const bookId = randomUUID();
  const versionId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into item_rate_books (id, org_id, code, name, currency)
    values (${bookId}, ${org.orgId}, 'STD', 'Standard', 'CAD')`));
  await withBypassContext(() => db.execute(sql`
    insert into item_rate_versions (id, org_id, rate_book_id, effective_from, status, custom)
    values (${versionId}, ${org.orgId}, ${bookId}, '2026-01-01', 'draft', '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    insert into labor_rate_version_policies (id, org_id, version_id, derivation_policy)
    values (${randomUUID()}, ${org.orgId}, ${versionId}, 'explicit')`));
  const assignCustomerB = randomUUID();
  const assignProjectB = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into item_rate_book_assignments
      (id, org_id, rate_book_id, customer_id, project_id, effective_from, effective_to,
       date_basis, is_active, created_by, updated_by)
    values (${assignCustomerB}, ${org.orgId}, ${bookId}, ${custB}, null,
            '2026-01-01', '2026-06-30', 'usage_date', true, ${actorId}, ${actorId}),
           (${assignProjectB}, ${org.orgId}, ${bookId}, null, ${projB},
            '2026-01-01', '2026-06-30', 'usage_date', true, ${actorId}, ${actorId})`));
  return { org, branchId, custA, custB, projA, projB, bookId, assignCustomerB, assignProjectB };
}

const get = (params: string) =>
  withOrgContext(state.orgId, () => GET(new Request(`http://rates.test/api/rate-book-assignments?${params}`)));

const send = (method: (req: Request) => Promise<Response>, body: unknown, id?: string) => {
  const url = new URL("http://rates.test/api/rate-book-assignments");
  if (id) url.searchParams.set("id", id);
  return withOrgContext(
    state.orgId,
    () =>
      method(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
      ),
  );
};

async function assignmentCount(orgId: string): Promise<number> {
  const rows = (
    await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from item_rate_book_assignments where org_id = ${orgId}`),
    )
  ).rows;
  return rows[0]!.n;
}

test("GET hides another subsidiary's customer and project assignments", { skip: !DB }, async () => {
  const { org, custA, custB, projB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const hiddenCustomer = await get(`customerId=${custB}`);
    assert.equal(hiddenCustomer.status, 404);
    assert.deepEqual(await hiddenCustomer.json(), { errorCode: "notFound" });
    const hiddenProject = await get(`projectId=${projB}`);
    assert.equal(hiddenProject.status, 404);
    assert.deepEqual(await hiddenProject.json(), { errorCode: "notFound" });
    const visible = await get(`customerId=${custA}`);
    assert.equal(visible.status, 200);
    assert.deepEqual(((await visible.json()) as { assignments: unknown[] }).assignments, []);
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("POST cannot price another subsidiary's project or customer", { skip: !DB }, async () => {
  const { org, custB, projB, bookId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const before = await assignmentCount(org.orgId);
    const onProject = await send(POST, {
      rateBookId: bookId, projectId: projB,
      effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31",
      dateBasis: "usage_date", isActive: true,
    });
    assert.equal(onProject.status, 404);
    assert.deepEqual(await onProject.json(), { errorCode: "notFound" });
    const onCustomer = await send(POST, {
      rateBookId: bookId, customerId: custB,
      effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31",
      dateBasis: "usage_date", isActive: true,
    });
    assert.equal(onCustomer.status, 404);
    assert.deepEqual(await onCustomer.json(), { errorCode: "notFound" });
    assert.equal(await assignmentCount(org.orgId), before, "refused creates write nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("PATCH and DELETE cannot touch another subsidiary's assignments", { skip: !DB }, async () => {
  const { org, assignCustomerB, assignProjectB, bookId } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const edit = await send(PATCH, {
      id: assignProjectB, rateBookId: bookId,
      effectiveFrom: "2026-02-01", effectiveTo: "2026-06-30",
      dateBasis: "usage_date", isActive: true,
    });
    assert.equal(edit.status, 404, JSON.stringify(await edit.json().catch(() => null)));
    const remove = await send(DELETE, undefined, assignCustomerB);
    assert.equal(remove.status, 404, JSON.stringify(await remove.json().catch(() => null)));
    assert.equal(await assignmentCount(org.orgId), 2, "refused writes change nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unrestricted caller keeps the full surface", { skip: !DB }, async () => {
  const { org, projB, bookId, assignProjectB } = await fixture();
  try {
    state.allowedSubsidiaryIds = null;
    const listed = await get(`projectId=${projB}`);
    assert.equal(listed.status, 200);
    assert.equal(((await listed.json()) as { assignments: unknown[] }).assignments.length, 1);
    const created = await send(POST, {
      rateBookId: bookId, projectId: projB,
      effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31",
      dateBasis: "usage_date", isActive: true,
    });
    assert.equal(created.status, 200, JSON.stringify(await created.json().catch(() => null)));
    const edited = await send(PATCH, {
      id: assignProjectB, rateBookId: bookId,
      effectiveFrom: "2026-01-01", effectiveTo: "2026-05-31",
      dateBasis: "usage_date", isActive: true,
    });
    assert.equal(edited.status, 200, JSON.stringify(await edited.json().catch(() => null)));
    const deleted = await send(DELETE, undefined, assignProjectB);
    assert.equal(deleted.status, 200);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
