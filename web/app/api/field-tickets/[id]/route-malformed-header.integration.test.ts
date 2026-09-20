import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Field-ticket PATCH regression: the header save builds its service patch with
// silent coercions, so malformed inputs succeed with 200 instead of failing
// closed — a malformed documentDate is silently dropped (the caller believes
// the date was saved) and a malformed foremanPartyId coerces to null (the
// stored foreman is silently wiped). The service layer already refuses bad
// dates (FieldTicketError), but the route pre-filter never delivers them.
// Only the session gate is stubbed; handler and storage are real.

const stateKey = Symbol.for("openbooks.fieldticket-malformed-header-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: string[] | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.fieldticket-malformed-header-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() {
    return null
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const patchRouteUrl = "./route.ts?fieldticket-malformed-header-test";
const { PATCH } = (await import(patchRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createFieldTicket, loadFieldTicket } = await import("../../../../lib/field-tickets.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function patchRequest(id: string, body: unknown): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://localhost/api/field-tickets/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

async function makeTicket(org: { orgId: string; subsidiaryId: string; customerId: string }, adminId: string) {
  return withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`);
    const projectId = randomUUID();
    await db.execute(sql`insert into projects
      (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-HDR', 'Header contract job',
              ${org.customerId}, 'active', true, '{}'::jsonb)`);
    return createFieldTicket(org.orgId, adminId, { projectId });
  });
}

test(
  "field-ticket PATCH refuses a malformed header document date instead of silently keeping the old one",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const created = await makeTicket(org, adminId);
      const loaded = await withOrgContext(org.orgId, () => loadFieldTicket(org.orgId, created.id));

      const attempt = patchRequest(created.id, {
        expectedRevision: loaded.revision,
        documentDate: "not-a-date",
      });
      const refused = await withOrgContext(org.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.ok(
        refused.status === 400 || refused.status === 422,
        `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(await refused.json())}`,
      );
      const after = await withOrgContext(org.orgId, () => loadFieldTicket(org.orgId, created.id));
      assert.equal(after.documentDate, loaded.documentDate, "refused date writes nothing");
      assert.equal(after.revision, loaded.revision, "refused date leaves the revision untouched");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "field-ticket PATCH refuses a malformed foreman reference instead of silently clearing the foreman",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const created = await makeTicket(org, adminId);
      const foreman = randomUUID();
      await withBypassContext(() => db.execute(sql`insert into parties (id, org_id, kind, display_name, is_active)
        values (${foreman}, ${org.orgId}, 'person', 'Crew Chief', true)`));
      await withBypassContext(() => db.execute(sql`update field_tickets set foreman_party_id = ${foreman}
        where document_id = ${created.id} and org_id = ${org.orgId}`));
      const loaded = await withOrgContext(org.orgId, () => loadFieldTicket(org.orgId, created.id));
      assert.equal(loaded.fieldTicket.foremanPartyId, foreman, "seed sets the foreman");

      const attempt = patchRequest(created.id, {
        expectedRevision: loaded.revision,
        foremanPartyId: "not-a-uuid",
      });
      const refused = await withOrgContext(org.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.ok(
        refused.status === 400 || refused.status === 422,
        `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(await refused.json())}`,
      );
      const after = await withOrgContext(org.orgId, () => loadFieldTicket(org.orgId, created.id));
      assert.equal(after.fieldTicket.foremanPartyId, foreman, "refused foreman writes nothing");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "field-ticket PATCH still saves a well-formed header under the exact revision",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const created = await makeTicket(org, adminId);
      const loaded = await withOrgContext(org.orgId, () => loadFieldTicket(org.orgId, created.id));

      const attempt = patchRequest(created.id, {
        expectedRevision: loaded.revision,
        memo: "header contract control",
      });
      const saved = await withOrgContext(org.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.equal(saved.status, 200, `control save must stay green: ${JSON.stringify(await saved.json())}`);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
