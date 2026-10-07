import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Authz } from "@/lib/authz-core";
import { stubModules } from "../../../../../testing/stub-modules.ts";

/**
 * The vendor compliance PATCH seals TINs and audits before/after evidence,
 * and refuses an out-of-scope party as not-found. These cases resolve the
 * actual user's role grants and subsidiary fence before invoking the
 * native route, without replacing its permission or scope predicates.
 */
// Node supplies no page-navigation environment; all authorization, feature,
// subsidiary scope, parsing, persistence and audit machinery stays native.
stubModules({ navigation: true });

const routeUrl = "./route.ts?compliance-vendor-scope-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts",
);
const { resolveAuthzByUserId } = await import("@/lib/authz-core");
const { withAuthzContext } = await import("@/lib/authz-context");

interface Fixture {
  orgId: string;
  rootSubsidiaryId: string;
  hiddenPartyId: string;
  actorId: string;
  authz: Authz | null;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Compliance Manager", "compliance_manager");
    const feature = await db.execute<{ id: string }>(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"subcontractorCompliance":true}'::jsonb)
       where id = ${org.orgId} returning id`);
    assert.equal(feature.rows.length, 1, "the native compliance feature must be enabled for this fixture");
    const branchId = randomUUID();
    const hiddenPartyId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, created_by, updated_by)
      values (${hiddenPartyId}, ${org.orgId}, 'company', 'Hidden Vendor', ${branchId}, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into vendor_roles
        (org_id, party_id, information_return_form, tax_classification,
         tin_encrypted, tin_last4, tin_type, backup_withholding, is_t4a, created_by, updated_by)
      values
        (${org.orgId}, ${hiddenPartyId}, '1099-MISC', 'individual',
         'sealed-original', '0000', 'ssn', false, false, ${actorId}, ${actorId})`);
    return { orgId: org.orgId, rootSubsidiaryId: org.subsidiaryId, hiddenPartyId, actorId, authz: null };
  });
}

async function authorize(fixture: Fixture, allowedSubsidiaryIds: ReadonlySet<string> | null): Promise<void> {
  fixture.authz = await withOrgContext(fixture.orgId, async () => {
    const restriction = allowedSubsidiaryIds === null
      ? { mode: "all" }
      : { mode: "list", subsidiaryIds: [...allowedSubsidiaryIds] };
    const role = await db.execute<{ id: string }>(sql`
      update app_roles set permissions = '["compliance.manage"]'::jsonb,
        subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
       where org_id = ${fixture.orgId} and key = 'compliance_manager' returning id`);
    assert.equal(role.rows.length, 1, "the fixture must configure its assigned native role");
    return resolveAuthzByUserId(fixture.orgId, fixture.actorId);
  });
  assert.ok(fixture.authz, "the native resolver must admit the active fixture actor");
  assert.ok(fixture.authz.permissions.has("compliance.manage"));
  assert.deepEqual(fixture.authz.allowedSubsidiaryIds, allowedSubsidiaryIds);
}

function patch(
  fixture: Fixture,
  body: unknown,
): Promise<Response> {
  const authority = fixture.authz;
  assert.ok(authority, "resolve the fixture actor's current authority before calling the route");
  return withOrgContext(fixture.orgId, () =>
    withAuthzContext(authority, () => PATCH(
      new Request(`http://openbooks.test/api/compliance/vendors/${fixture.hiddenPartyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ partyId: fixture.hiddenPartyId }) },
    )),
  );
}

async function tinState(fixture: Fixture): Promise<{ last4: string | null; type: string | null }> {
  return withOrgContext(fixture.orgId, async () => {
    const result = await db.execute<{ last4: string | null; type: string | null }>(sql`
      select tin_last4 as "last4", tin_type as "type" from vendor_roles
       where org_id = ${fixture.orgId} and party_id = ${fixture.hiddenPartyId}`);
    return result.rows[0]!;
  });
}

test(
  "a subsidiary-restricted compliance save cannot touch a hidden-entity vendor TIN",
  async () => {
    const fixture = await seed();
    try {
      await authorize(fixture, new Set([fixture.rootSubsidiaryId]));
      const response = await patch(fixture, {
        tin: "222-33-4444",
        tinType: "ein",
        reason: "smuggled TIN overwrite",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await tinState(fixture), { last4: "0000", type: "ssn" });

      // Unrestricted callers keep the established behavior.
      await authorize(fixture, null);
      const allowed = await patch(fixture, {
        tin: "222-33-4444",
        tinType: "ein",
        reason: "W-9 reviewed by compliance",
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(await tinState(fixture), { last4: "4444", type: "ein" });
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "a vendor TIN save audits secret-free before/after snapshots under the same lock",
  async () => {
    // The route locks vendor_roles, snapshots tin_present/tin_last4 without
    // persisting ciphertext, and answers with row identity alone.
    const fixture = await seed();
    try {
      await authorize(fixture, null);
      const response = await patch(fixture, {
        tin: "222-33-4444",
        tinType: "ein",
        reason: "W-9 reviewed by compliance",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { partyId: fixture.hiddenPartyId });

      const audits = await withOrgContext(fixture.orgId, () =>
        db.execute<{
          action: string;
          actor: string;
          changes: { reason: string; before: Record<string, unknown>; after: Record<string, unknown> };
        }>(sql`
          select action, actor_id as "actor", changes from audit_log
           where org_id = ${fixture.orgId} and table_name = 'vendor_roles'
             and row_id = ${fixture.hiddenPartyId}
           order by at desc limit 1`),
      );
      assert.equal(audits.rows.length, 1, "the TIN save writes one audit row");
      const entry = audits.rows[0]!;
      assert.equal(entry.action, "update");
      assert.equal(entry.actor, fixture.actorId);
      assert.equal(entry.changes.reason, "W-9 reviewed by compliance");
      assert.equal(entry.changes.before["tin_last4"], "0000");
      assert.equal(entry.changes.after["tin_last4"], "4444");
      assert.equal(entry.changes.before["tin_present"], true);
      assert.equal(entry.changes.after["tin_present"], true);
      for (const snapshot of [entry.changes.before, entry.changes.after]) {
        assert.ok(!("tin_encrypted" in snapshot), "no ciphertext key in the audit snapshot");
      }
      assert.ok(
        !JSON.stringify(entry.changes).includes("sealed-original"),
        "the prior ciphertext is not persisted in the trail",
      );
    } finally {
      await dropScratchOrg(fixture.orgId);
    }
  },
);
