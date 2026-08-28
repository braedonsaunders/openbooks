import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

/**
 * Live-PostgreSQL regression for fnd_mtcbbunr_7k3wlv.  The vendor compliance
 * PATCH used to commit the role mutation and its audit row as two independent
 * statements.  These cases invoke the real route: a successful save records
 * exact stored before/after evidence, while a database-triggered audit failure
 * proves the compliance and encrypted-TIN changes roll back together.
 */
const stateKey = Symbol.for("openbooks.compliance-vendor-audit-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.compliance-vendor-audit-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
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
    if (specifier === "@/lib/authz") return { url: "mock:compliance-authz", shortCircuit: true };
    if (specifier === "@/lib/compliance") return { url: "mock:compliance-gate", shortCircuit: true };
    // Resolve this worktree's engine directly.  This keeps the route and the
    // fixture helpers on one db module even when node_modules is shared.
    if (specifier.startsWith("@openbooks/engine/")) {
      const engineRoot = new URL("../../engine/", import.meta.url);
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
    if (url === "mock:compliance-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:compliance-gate") {
      return { format: "module", source: mockCompliance, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/compliance/vendors/[partyId]/route.ts?compliance-vendor-audit-test";
const { PATCH } = (await import(routeUrl)) as typeof import("../app/api/compliance/vendors/[partyId]/route.ts");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);
hooks.deregister();

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  partyId: string;
  actorId: string;
  complianceClassId: string;
}

async function seed(): Promise<Fixture> {
  return withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Compliance Admin", "compliance_admin");
    const complianceClassId = randomUUID();
    await db.execute(sql`
      insert into compliance_classes
        (id, org_id, code, name, lien_waiver_enforcement, default_information_return,
         created_by, updated_by)
      values
        (${complianceClassId}, ${org.orgId}, 'SUB', 'Subcontractor', 'none', '1099-NEC',
         ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into vendor_roles
        (org_id, party_id, information_return_form, information_return_box,
         tax_classification, tin_encrypted, tin_last4, tin_type,
         backup_withholding, is_t4a, created_by, updated_by)
      values
        (${org.orgId}, ${org.vendorId}, '1099-MISC', '1', 'individual',
         'old-ciphertext', '1111', 'ssn', false, false, ${actorId}, ${actorId})`);
    return {
      orgId: org.orgId,
      partyId: org.vendorId,
      actorId,
      complianceClassId,
    };
  });
}

function authorize(fixture: Fixture): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    permissions: new Set(["compliance.manage"]),
    allowedSubsidiaryIds: null,
  };
}

function request(fixture: Fixture, body: unknown): Request {
  return new Request(`http://openbooks.test/api/compliance/vendors/${fixture.partyId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(fixture: Fixture, body: unknown): Promise<Response> {
  return withOrgContext(fixture.orgId, () =>
    PATCH(request(fixture, body), { params: Promise.resolve({ partyId: fixture.partyId }) }),
  );
}

async function roleState(fixture: Fixture): Promise<Record<string, unknown>> {
  return withOrgContext(fixture.orgId, async () => {
    const result = await db.execute<Record<string, unknown>>(sql`
      select id, org_id, party_id, compliance_class_id, information_return_form,
             information_return_box, tax_classification, tin_encrypted, tin_last4,
             tin_type, backup_withholding, is_t4a, is_active, created_at, created_by,
             updated_at, updated_by
        from vendor_roles
       where org_id = ${fixture.orgId} and party_id = ${fixture.partyId}`);
    return result.rows[0]!;
  });
}

async function audits(fixture: Fixture): Promise<{
  actor_id: string;
  at: string | Date;
  changes: { reason: string; before: Record<string, unknown>; after: Record<string, unknown> };
}[]> {
  return withOrgContext(fixture.orgId, async () => {
    const result = await db.execute<{
      actor_id: string;
      at: string | Date;
      changes: { reason: string; before: Record<string, unknown>; after: Record<string, unknown> };
    }>(sql`
      select actor_id, at, changes
        from audit_log
       where org_id = ${fixture.orgId}
         and table_name = 'vendor_roles' and row_id = ${fixture.partyId}
       order by at, id`);
    return result.rows;
  });
}

async function installAuditFailure(actorId: string): Promise<() => Promise<void>> {
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const functionName = `vendor_audit_failure_${suffix}`;
  const triggerName = `vendor_audit_failure_trigger_${suffix}`;
  await withBypass(() =>
    db.execute(sql.raw(`
      create function public."${functionName}"() returns trigger
      language plpgsql as $$
      begin
        if new.table_name = 'vendor_roles' and new.actor_id = '${actorId}'::uuid then
          raise exception 'forced vendor audit failure';
        end if;
        return new;
      end $$;
      create trigger "${triggerName}"
        before insert on audit_log
        for each row execute function public."${functionName}"();
    `)),
  );
  return async () => {
    await withBypass(() =>
      db.execute(sql.raw(`
        drop trigger if exists "${triggerName}" on audit_log;
        drop function if exists public."${functionName}"();
      `)),
    );
  };
}

test(
  "a successful compliance/TIN save records attributable exact before/after evidence",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      authorize(fixture);
      const before = await roleState(fixture);
      const response = await patch(fixture, {
        complianceClassId: fixture.complianceClassId,
        informationReturnForm: "1099-NEC",
        informationReturnBox: "1",
        taxClassification: "llc",
        tin: "222-33-4444",
        tinType: "ein",
        backupWithholding: true,
        reportable: true,
        reason: "W-9 reviewed by compliance",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { partyId: fixture.partyId });

      const after = await roleState(fixture);
      assert.equal(after.compliance_class_id, fixture.complianceClassId);
      assert.equal(after.information_return_form, "1099-NEC");
      assert.equal(after.tax_classification, "llc");
      assert.equal(after.tin_last4, "4444");
      assert.equal(after.tin_type, "ein");
      assert.equal(after.backup_withholding, true);
      assert.equal(after.is_t4a, true);
      assert.notEqual(after.tin_encrypted, "222-33-4444");

      const trail = await audits(fixture);
      assert.equal(trail.length, 1);
      assert.equal(trail[0]!.actor_id, fixture.actorId);
      assert.ok(!Number.isNaN(Date.parse(String(trail[0]!.at))), "audit timestamp is populated");
      assert.equal(trail[0]!.changes.reason, "W-9 reviewed by compliance");
      assert.equal(trail[0]!.changes.before.tin_last4, before.tin_last4);
      assert.equal(trail[0]!.changes.after.tin_last4, after.tin_last4);
      assert.equal(trail[0]!.changes.after.tin_present, true);
      assert.equal(trail[0]!.changes.after.tin_type, after.tin_type);
      assert.equal(trail[0]!.changes.after.backup_withholding, after.backup_withholding);
      assert.equal(trail[0]!.changes.after.is_t4a, after.is_t4a);
      assert.equal("tin_encrypted" in trail[0]!.changes.after, false);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(fixture.orgId);
    }
  },
);

test(
  "a forced audit failure rolls compliance and encrypted-TIN changes back",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    let removeFailure: (() => Promise<void>) | undefined;
    try {
      authorize(fixture);
      const before = await roleState(fixture);
      removeFailure = await installAuditFailure(fixture.actorId);
      const response = await patch(fixture, {
        complianceClassId: fixture.complianceClassId,
        taxClassification: "trust_estate",
        tin: "999-88-7777",
        tinType: "itin",
        backupWithholding: true,
        reportable: true,
      });
      assert.equal(response.status, 400);
      const failure = (await response.json()) as { error?: unknown };
      assert.equal(typeof failure.error, "string", "the failed audit is surfaced as a storage error");
      assert.deepEqual(await roleState(fixture), before);
      assert.deepEqual(await audits(fixture), []);
    } finally {
      routeState.authz = null;
      await removeFailure?.();
      await dropScratchOrg(fixture.orgId);
    }
  },
);
