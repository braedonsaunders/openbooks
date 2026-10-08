import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Labour rate-book assignments price the customer or project they hang
 * off, so a projects.manage holder restricted to one subsidiary must not
 * read, create, change, or delete assignments on another subsidiary's
 * records. Project scope is strict; customer parties scope under the
 * shared-party policy. Every denial answers the uniform not-found, so
 * probing ids never oracles what another entity holds.
 *
 * A fixture principal enters the native request authorization context.
 * Permission, feature and scope gates, project locks and snapshots use
 * production code.
 */
const state = {
  orgId: "",
  actorId: "",
  permissions: new Set<string>(["projects.read", "projects.manage"]),
  allowedSubsidiaryIds: null as ReadonlySet<string> | null,
};
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}");
    if (specifier === "next/headers")
      return virtual("export function cookies() { throw new Error('no cookies in route test') }");
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
const { withAuthzContext } = await import('../../../lib/authz-context.ts');

function asPrincipal<T>(work: () => T): T {
  return withAuthzContext({
    user: { id: state.actorId, orgId: state.orgId, email: 'pricing@example.test', name: 'Pricing administrator',
      roles: [], envKind: 'production', productionOrgId: state.orgId,
      homeUserId: state.actorId, homeOrgId: state.orgId, isSuperAdmin: false },
    permissions: new Set(state.permissions),
    allowedSubsidiaryIds: state.allowedSubsidiaryIds === null ? null : new Set(state.allowedSubsidiaryIds),
  }, work);
}


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
  return { org, branchId, custA, custB, projA, projB, bookId, versionId, assignCustomerB, assignProjectB };
}

const get = (params: string) =>
  withOrgContext(state.orgId, () => asPrincipal(() => GET(new Request(`http://rates.test/api/rate-book-assignments?${params}`))));

const send = (method: (req: Request) => Promise<Response>, body: unknown, id?: string) => {
  const url = new URL("http://rates.test/api/rate-book-assignments");
  if (id) url.searchParams.set("id", id);
  return withOrgContext(
    state.orgId,
    () => asPrincipal(() =>
      method(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }),
      )),
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

test("GET hides another subsidiary's customer and project assignments", async () => {
  const { org, custA, custB, projB } = await fixture();
  try {
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const hiddenCustomer = await get(`customerId=${custB}`);
    assert.equal(hiddenCustomer.status, 404);
    assert.deepEqual(await hiddenCustomer.json(), { error: "not_found" });
    const hiddenProject = await get(`projectId=${projB}`);
    assert.equal(hiddenProject.status, 404);
    assert.deepEqual(await hiddenProject.json(), { error: "not_found" });
    const visible = await get(`customerId=${custA}`);
    assert.equal(visible.status, 200);
    assert.deepEqual(((await visible.json()) as { assignments: unknown[] }).assignments, []);
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("POST cannot price another subsidiary's project or customer", async () => {
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
    assert.deepEqual(await onProject.json(), { error: "not_found" });
    const onCustomer = await send(POST, {
      rateBookId: bookId, customerId: custB,
      effectiveFrom: "2026-07-01", effectiveTo: "2026-12-31",
      dateBasis: "usage_date", isActive: true,
    });
    assert.equal(onCustomer.status, 404);
    assert.deepEqual(await onCustomer.json(), { error: "not_found" });
    assert.equal(await assignmentCount(org.orgId), before, "refused creates write nothing");
  } finally {
    state.allowedSubsidiaryIds = null;
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("PATCH and DELETE cannot touch another subsidiary's assignments", async () => {
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

test("an unrestricted caller keeps the full surface", async () => {
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

test("native pricing authors an explicit nondefault card and retains a selected contract version outside its window", async () => {
  const { org, projA, projB, bookId, versionId } = await fixture();
  const foreign = await withBypassContext(() => createScratchOrg());
  const { POST: saveBook } = await import('../item-rate-books/route.ts');
  const { PUT: saveVersion } = await import('../labor-rate-cards/[id]/route.ts');
  const { resolveItemRate } = await import('../../../lib/item-rates.ts');
  state.permissions.add('admin.setup.manage');
  state.allowedSubsidiaryIds = null;
  try {
    const created = await send(saveBook, {
      code: 'CONTRACT', name: 'Contract rates', isDefault: false,
    });
    assert.equal(created.status, 200, await created.clone().text());
    const card = (await created.json()).id as string;
    const version = randomUUID();
    const lineId = randomUUID();
    // The fixture supplies a draft policy; the native editor owns its lines,
    // effective window and activation before the assignment can select it.
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`insert into item_rate_versions(id,org_id,rate_book_id,effective_from,status)
        values(${version},${org.orgId},${card},'2025-01-01','draft')`);
      await db.execute(sql`insert into labor_rate_version_policies(org_id,version_id,derivation_policy)
        values(${org.orgId},${version},'explicit')`);
      await db.execute(sql`insert into item_rate_profiles(org_id,item_id,base_unit,pricing_policy,invoice_presentation)
        values(${org.orgId},${org.items.service},'hour','capped_ladder','summary')`);
      await db.execute(sql`insert into item_rate_lines(id,org_id,version_id,item_id,unit_code,unit_name,base_quantity,cost_rate)
        values(${lineId},${org.orgId},${version},${org.items.service},'hour','Hour','1','33.25')`);
    });
    const activated = await withOrgContext(org.orgId, () => asPrincipal(() => saveVersion(new Request(
      `http://rates.test/api/labor-rate-cards/${version}`, { method: 'PUT',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          code: 'CONTRACT', name: 'Contract rates', effective_from: '2025-01-01',
          effective_to: '2025-12-31', status: 'active', derivation_policy: 'explicit',
          scopes: [], lines: [{ id: lineId, itemId: org.items.service, regular: '65', timeTypeRates: {} }],
          adjustments: [], terms: [],
        }),
      }), { params: Promise.resolve({ id: version }) })));
    assert.equal(activated.status, 200, await activated.clone().text());
    assert.deepEqual((await withOrgContext(org.orgId, () => db.execute(sql`
      select is_default from item_rate_books where org_id=${org.orgId} and id=${card}`))).rows,
    [{ is_default: false }], 'explicit nondefault pricing never installs an organization fallback');
    const originalVersions = (await withOrgContext(org.orgId, () => db.execute(sql`
      select to_jsonb(v) as row from item_rate_versions v where org_id=${org.orgId} order by id`))).rows;
    const originalLines = (await withOrgContext(org.orgId, () => db.execute(sql`
      select to_jsonb(l) as row from item_rate_lines l where org_id=${org.orgId} order by id`))).rows;
    const made = await send(POST, { rateBookId: card, rateVersionId: version, projectId: projA,
      effectiveFrom: null, effectiveTo: null, dateBasis: 'usage_date', isActive: true });
    assert.equal(made.status, 200, await made.clone().text());
    const assignmentId = (await made.json()).id as string;
    const read = async () => (await withOrgContext(org.orgId, () => db.execute(sql`
      select rate_book_id,rate_version_id,effective_from,effective_to,date_basis,is_active
      from item_rate_book_assignments where org_id=${org.orgId} and id=${assignmentId}`))).rows[0];
    const expected = { rate_book_id: card, rate_version_id: version,
      effective_from: null, effective_to: null, date_basis: 'usage_date', is_active: true };
    assert.deepEqual(await read(), expected);
    const reopened = await get(`projectId=${projA}`);
    assert.equal(reopened.status, 200);
    const listing = await reopened.json();
    assert.equal(listing.assignments[0].pinned_rate_version_id, version);
    assert.equal(listing.rateBooks.find((b: { id: string }) => b.id === card).versions[0].id, version);
    const priced = await resolveItemRate({ orgId: org.orgId, projectId: projA,
      itemId: org.items.service, onDate: '2026-01-08', baseQuantity: '1' });
    assert.equal(priced?.rateVersionId, version);
    assert.equal(priced?.bill.amount, '65.0000');
    const ordinaryEdit = await send(PATCH, { id: assignmentId, effectiveTo: '2026-01-31' });
    assert.equal(ordinaryEdit.status, 200, await ordinaryEdit.clone().text());
    assert.deepEqual(await read(), { ...expected, effective_to: '2026-01-31' },
      'an ordinary edit preserves the selected policy when the pin is omitted');
    const audit = (await withOrgContext(org.orgId, () => db.execute<{ changes: { before: { rate_version_id: string }; after: { rate_version_id: string } }; actor_id: string }>(sql`
      select changes,actor_id from audit_log where org_id=${org.orgId}
        and table_name='item_rate_book_assignments' and row_id=${assignmentId}
        and action='update' order by at desc,id desc limit 1`))).rows[0]!;
    assert.equal(audit.actor_id, state.actorId);
    assert.equal(audit.changes.before.rate_version_id, version);
    assert.equal(audit.changes.after.rate_version_id, version);
    const beforeRefusals = await read();
    const auditCount = (await withOrgContext(org.orgId, () => db.execute(sql`
      select id from audit_log where org_id=${org.orgId}`))).rows.length;
    for (const body of [
      { id: assignmentId, rateVersionId: versionId }, // Different card, draft policy.
      { id: assignmentId, rateBookId: bookId }, // Changing the card cannot discard its pin.
      { id: assignmentId, rateVersionId: randomUUID() },
    ]) {
      const refused = await send(PATCH, body);
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), { errorCode: 'version' });
      assert.deepEqual(await read(), beforeRefusals);
    }
    const foreignBook = randomUUID(), foreignVersion = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into item_rate_books(id,org_id,code,name,currency)
        values(${foreignBook},${foreign.orgId},'FOREIGN','Foreign card','CAD')`);
      await db.execute(sql`insert into item_rate_versions(id,org_id,rate_book_id,effective_from)
        values(${foreignVersion},${foreign.orgId},${foreignBook},'2025-01-01')`);
    });
    const crossTenant = await send(PATCH, { id: assignmentId, rateVersionId: foreignVersion });
    assert.equal(crossTenant.status, 400);
    assert.deepEqual(await crossTenant.json(), { errorCode: 'version' });
    assert.deepEqual(await read(), beforeRefusals);
    state.allowedSubsidiaryIds = new Set([org.subsidiaryId]);
    const hidden = await send(POST, { rateBookId: card, rateVersionId: version, projectId: projB,
      effectiveFrom: null, effectiveTo: null, dateBasis: 'usage_date', isActive: true });
    assert.equal(hidden.status, 404);
    assert.equal((await withOrgContext(org.orgId, () => db.execute(sql`
      select id from audit_log where org_id=${org.orgId}`))).rows.length, auditCount);
    state.allowedSubsidiaryIds = null;
    const unpin = await send(PATCH, { id: assignmentId, rateVersionId: null });
    assert.equal(unpin.status, 200, await unpin.clone().text());
    assert.equal((await read())!.rate_version_id, null);
    assert.equal(await resolveItemRate({ orgId: org.orgId, projectId: projA,
      itemId: org.items.service, onDate: '2026-01-08', baseQuantity: '1' }), null,
    'automatic lookup retains the unpriced gap instead of extending an expired contract');
    assert.deepEqual((await withOrgContext(org.orgId, () => db.execute(sql`
      select to_jsonb(v) as row from item_rate_versions v where org_id=${org.orgId} order by id`))).rows, originalVersions);
    assert.deepEqual((await withOrgContext(org.orgId, () => db.execute(sql`
      select to_jsonb(l) as row from item_rate_lines l where org_id=${org.orgId} order by id`))).rows, originalLines);
    const automaticDefault = await send(saveBook, { code: 'AUTO', name: 'Default rates' });
    assert.equal(automaticDefault.status, 200, await automaticDefault.clone().text());
    const defaultId = (await automaticDefault.json()).id as string;
    assert.deepEqual((await withOrgContext(org.orgId, () => db.execute(sql`
      select id,is_default from item_rate_books where org_id=${org.orgId} and is_default`))).rows,
    [{ id: defaultId, is_default: true }], 'omitting the choice retains the first-book default behavior');
  } finally {
    state.allowedSubsidiaryIds = null;
    state.permissions.delete('admin.setup.manage');
    await withBypassContext(() => dropScratchOrg(foreign.orgId));
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
