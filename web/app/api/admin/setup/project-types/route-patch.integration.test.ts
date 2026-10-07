import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Project-type PATCH must not clobber fields the caller did not send. The
 * collection POST requires a non-empty name, but PATCH unconditionally wrote
 * name/description/is-active/sort-order from body-or-default — so a PATCH
 * that only changed the billing classification blanked the name, wiped the
 * description, reset the sort order to 50, and silently reactivated an
 * archived type.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __projectTypePatchUser: state });
registerHooks({
  resolve(specifier, context, next) {
    // The route factory imports the gate by @/ alias at request time, from
    // web/lib/api/route.ts rather than the route directory; serve it the
    // same intended session as the route's own import.
    if (specifier === "@/lib/authz" || (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/admin/setup/project-types/"))) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export { guardUnrestrictedScope } from '${root}web/lib/authz.ts';export async function guardPermission(){return {user:globalThis.__projectTypePatchUser.user,permissions:new Set(['*']),allowedSubsidiaryIds:null}}`,
          ),
      };
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST, PATCH } = await import("./route");
const { BUILTIN_PROJECT_TYPES } = await import("@openbooks/schema");

const patchJson = (body: unknown) =>
  new Request("http://audit.local/api/admin/setup/project-types", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const STANDARD_PROFILE = {
  billingProcedure: "standard",
  allowedBases: ["time_selection"],
  defaultBasis: "time_selection",
};

async function typeRow(orgId: string, id: string) {
  const r = await withBypassContext(() =>
    db.execute<{ name: string; description: string | null; is_active: boolean; sort_order: number }>(
      sql`select name, description, is_active, sort_order from project_types where id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0]!;
}

test("project-type PATCH leaves unsent fields alone and rejects a blank name", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    await withBypassContext(() =>
      db.execute(sql`update orgs set settings = settings || '{"features": {"projects": true}}'::jsonb where id = ${org.orgId}`),
    );
    const id = '01234567-89ab-0cde-0123-456789abcdef';
    await withBypassContext(() => db.execute(sql`insert into project_types
      (id, org_id, key, name, description, is_active, sort_order, billing_method, invoicing_profile, backup_profile)
      values (${id}, ${org.orgId}, 'tm', 'Time and materials', 'Hourly work', false, 7,
        'time_and_materials', ${JSON.stringify(STANDARD_PROFILE)}::jsonb, '{}'::jsonb)`));

    // A PATCH that only touches the billing classification must not rewrite
    // the name, description, active flag, or sort order.
    const touched = await PATCH(patchJson({ id, billingMethod: "cost_plus" }));
    assert.equal(touched.status, 200, JSON.stringify(await touched.clone().json()));
    assert.deepEqual(await typeRow(org.orgId, id), {
      name: "Time and materials",
      description: "Hourly work",
      is_active: false,
      sort_order: 7,
    });

    // A blank name is refused, like the collection POST requires.
    const blanked = await PATCH(patchJson({ id, billingMethod: "cost_plus", name: "  " }));
    assert.equal(blanked.status, 422, JSON.stringify(await blanked.clone().json()));
    assert.equal((await typeRow(org.orgId, id)).name, "Time and materials");

    // Controls: sent fields still write.
    const renamed = await PATCH(patchJson({ id, billingMethod: "cost_plus", name: "T&M", sortOrder: 3, isActive: true }));
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.clone().json()));
    assert.deepEqual(await typeRow(org.orgId, id), {
      name: "T&M",
      description: "Hourly work",
      is_active: true,
      sort_order: 3,
    });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("project-type authoring preserves declared invoicing policies and refuses unsafe replacements without audit or state changes", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const neighbor = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    await withBypassContext(() => db.execute(sql`update orgs set settings = settings || '{"features":{"projects":true}}'::jsonb where id = ${org.orgId}`));
    const itemId = '01234567-89ab-0cde-0123-456789abcdef';
    const foreignItemId = randomUUID();
    const retiredItemId = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into items (id, org_id, kind, name, is_active) values
      (${itemId}, ${org.orgId}, 'service', 'Grouped labor', true),
      (${retiredItemId}, ${org.orgId}, 'service', 'Retired adjustment', false),
      (${foreignItemId}, ${neighbor.orgId}, 'service', 'Neighbor labor', true)`));
    const original = {
      billingProcedure: 'standard', allowedBases: ['date_range'], defaultBasis: 'date_range',
      lineBuilder: 'cost_plus', revenueAccount: 'item_income', recognition: 'percent_complete_cost',
      markupPresentation: 'lump_sum', notToExceed: true, notToExceedItemId: itemId,
      costSourceKinds: ['vendor_bill', 'sales_order'], rateCardLapse: 'carry_forward',
      ticketCostScope: 'ticket_or_period', lineGrouping: 'per_item', surchargeRounding: 'down',
      rollup: { mode: 'by_group', keepDetail: true, groups: [{ label: 'Labor', itemId, isLabor: true }] },
    };
    const builtIn = BUILTIN_PROJECT_TYPES.find(type => type.key === 'cost_plus')!;
    const created = await POST(new Request('http://audit.local/api/admin/setup/project-types', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'configured_cost', name: 'Configured cost', billingMethod: 'cost_plus',
        invoicingProfile: original, financialProfile: builtIn.financialProfile, backupProfile: builtIn.backupProfile }),
    }));
    assert.equal(created.status, 200, JSON.stringify(await created.clone().json()));
    const { id } = await created.json() as { id: string };
    const read = () => withBypassContext(async () => {
      const row = await db.execute<{ invoicing_profile: unknown }>(sql`select invoicing_profile from project_types where org_id = ${org.orgId} and id = ${id}`);
      const audits = await db.execute<{ action: string; actor_id: string; changes: { before?: { invoicing_profile: unknown }; after: { invoicingProfile?: unknown; invoicing_profile?: unknown } } }>(sql`
        select action, actor_id, changes from audit_log where org_id = ${org.orgId} and table_name = 'project_types' and row_id = ${id} order by at, id`);
      return { profile: row.rows[0]!.invoicing_profile, audits: audits.rows };
    });
    const first = await read();
    assert.deepEqual(first.profile, original);
    assert.equal(first.audits.length, 1);
    assert.equal(first.audits[0]!.actor_id, state.user.id);
    assert.deepEqual(first.audits[0]!.changes.after.invoicingProfile, original);
    const changed = { ...original, recognition: 'as_invoiced', rateCardLapse: 'block', surchargeRounding: 'half_up' };
    const saved = await PATCH(patchJson({ id, billingMethod: 'cost_plus', invoicingProfile: changed }));
    assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
    const second = await read();
    assert.deepEqual(second.profile, changed);
    assert.equal(second.audits.length, 2);
    const update = second.audits.find(audit => audit.action === 'update')!;
    assert.equal(update.actor_id, state.user.id);
    assert.deepEqual(update.changes.before!.invoicing_profile, original);
    assert.deepEqual(update.changes.after.invoicing_profile, changed);
    for (const profile of [
      { ...changed, recognition: 'unknown' }, { ...changed, rateCardLapse: 'ignore' },
      { ...changed, rollup: { mode: 'by_group', groups: [{ label: 'Everything' }] } },
      { ...changed, rollup: { mode: 'by_group', groups: [] } },
      { ...changed, unknownPolicy: true },
      { ...changed, notToExceedItemId: foreignItemId }, { ...changed, notToExceedItemId: retiredItemId },
      { ...changed, rollup: { ...changed.rollup, groups: [{ label: 'Labor', isLabor: true, itemId: foreignItemId }] } },
    ]) {
      const refused = await PATCH(patchJson({ id, billingMethod: 'cost_plus', invoicingProfile: profile }));
      assert.equal(refused.status, 422, JSON.stringify(await refused.clone().json()));
      const body = await refused.json();
      assert.ok(body.error);
      if (profile.notToExceedItemId === foreignItemId || profile.notToExceedItemId === retiredItemId || JSON.stringify(profile.rollup).includes(foreignItemId))
        assert.match(body.error, /choose an active company item/);
      assert.deepEqual(await read(), second);
    }
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
    await withBypassContext(() => dropScratchOrg(neighbor.orgId));
  }
});
