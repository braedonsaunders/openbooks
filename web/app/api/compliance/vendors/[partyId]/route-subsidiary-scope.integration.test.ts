import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * The vendor compliance PATCH seals TINs and audits before/after evidence,
 * but it never checked the party's subsidiary against the caller's fence —
 * every sibling mutation (party PATCH, bank-account writes) refuses
 * out-of-scope parties as not-found. A subsidiary-restricted
 * compliance.manage holder could overwrite or clear the TIN and compliance
 * classification of a hidden-entity vendor. These cases invoke the real
 * route with a restricted fence.
 */
const stateKey = Symbol.for("openbooks.compliance-vendor-scope-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.compliance-vendor-scope-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}) {
    const allowed = authz.allowedSubsidiaryIds
    const orgWideNull = opts.orgWideNull === true
    if (allowed === null) return null
    if ((subsidiaryId === null || subsidiaryId === undefined) && orgWideNull) return null
    if (typeof subsidiaryId === 'string' && allowed.has(subsidiaryId)) return null
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }
`;

const mockCompliance = `
  export async function guardComplianceFeature(_orgId) { return null }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz") return { url: "mock:compliance-scope-authz", shortCircuit: true };
    if (specifier === "@/lib/compliance") return { url: "mock:compliance-scope-gate", shortCircuit: true };
    if (specifier.startsWith("@openbooks/engine/")) {
      const engineRoot = new URL("../../../../../../engine/", import.meta.url);
      return {
        url: new URL(specifier.slice("@openbooks/engine/".length), engineRoot).href,
        shortCircuit: true,
      };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:compliance-scope-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:compliance-scope-gate") {
      return { format: "module", source: mockCompliance, shortCircuit: true };
    }
    return nextLoad(url, context)
  },
});

const routeUrl = "./route.ts?compliance-vendor-scope-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts",
);
hooks.deregister();

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  rootSubsidiaryId: string;
  hiddenPartyId: string;
  actorId: string;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Compliance Manager", "compliance_manager");
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
    return { orgId: org.orgId, rootSubsidiaryId: org.subsidiaryId, hiddenPartyId, actorId };
  });
}

function authorize(fixture: Fixture, allowedSubsidiaryIds: ReadonlySet<string> | null): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["compliance.manage"]),
    allowedSubsidiaryIds,
  };
}

function patch(
  fixture: Fixture,
  body: unknown,
): Promise<Response> {
  return withOrgContext(fixture.orgId, () =>
    PATCH(
      new Request(`http://openbooks.test/api/compliance/vendors/${fixture.hiddenPartyId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ partyId: fixture.hiddenPartyId }) },
    ),
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
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture, new Set([fixture.rootSubsidiaryId]));
      const response = await patch(fixture, {
        tin: "222-33-4444",
        tinType: "ein",
        reason: "smuggled TIN overwrite",
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await tinState(fixture), { last4: "0000", type: "ssn" });

      // Unrestricted callers keep the established behavior.
      authorize(fixture, null);
      const allowed = await patch(fixture, {
        tin: "222-33-4444",
        tinType: "ein",
        reason: "W-9 reviewed by compliance",
      });
      assert.equal(allowed.status, 200);
      assert.deepEqual(await tinState(fixture), { last4: "4444", type: "ein" });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);
