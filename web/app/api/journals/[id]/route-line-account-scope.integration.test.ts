import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Journals PATCH validates line accountIds for UUID shape only (zod uuidId),
// never for organization ownership — the same gap 0772f4190 closed in the
// shared applyDocumentEdit service (and ea672599b in the order handlers).
// A well-formed foreign-org account passes the boundary and dies at the
// tenant-coherent lines FK as an unhandled storage 500 deep in the save
// transaction. Only the session gate is stubbed; handler and storage are real.

const stateKey = Symbol.for("openbooks.journal-line-account-test");
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
  const state = globalThis[Symbol.for('openbooks.journal-line-account-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() {
    return null
  }
  export function subsidiariesInScope() {
    return true
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

const patchRouteUrl = "./route.ts?journal-line-account-test";
const { PATCH } = (await import(patchRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { documentRevisionCounterSql } = await import("../../../../../engine/src/records/revision.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function patchRequest(id: string, body: unknown): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://localhost/api/journals/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

async function revisionToken(orgId: string, documentId: string): Promise<string> {
  const row = (await withOrgContext(orgId, () => db.execute<{ updatedAt: string }>(sql`
    select ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt"
      from documents where id = ${documentId}
  `)));
  return row.rows[0]!.updatedAt;
}

test(
  "journals PATCH refuses a foreign-org line account with a domain error",
  { skip: !DB },
  async () => {
    const orgA = await withBypassContext(() => createScratchOrg());
    const orgB = await withBypassContext(() => createScratchOrg());
    try {
      const { adminId } = await withBypassContext(() => seedFlowActors(orgA.orgId));
      routeState.authz = {
        user: { orgId: orgA.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const documentId = randomUUID();
      await withBypassContext(() => db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date,
           currency, fx_rate, status, subtotal, tax_total, total, custom,
           created_by, updated_by)
        values (
          ${documentId}, ${orgA.orgId}, 'journal', 'JE-ALIEN-ACCT-1',
          ${orgA.subsidiaryId}, ${orgA.date}, 'CAD', 1, 'draft', 100, 0, 100,
          '{}'::jsonb, ${adminId}, ${adminId}
        )
      `));
      const token = await revisionToken(orgA.orgId, documentId);
      // orgB's real COGS account: well-formed, active, but another tenant's.
      const attempt = patchRequest(documentId, {
        expectedUpdatedAt: token,
        lines: [{ accountId: orgB.accounts.cogs, amount: "100", description: "alien leg" }],
      });
      const refused = await withOrgContext(orgA.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.ok(
        refused.status === 404 || refused.status === 422,
        `expected a domain 4xx, got ${refused.status}`,
      );
      const lines = (await withOrgContext(orgA.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_lines where document_id = ${documentId} and org_id = ${orgA.orgId}
      `))).rows[0]!.n;
      assert.equal(lines, 0, 'refused foreign-account lines store nothing');
    } finally {
      routeState.authz = null;
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);
