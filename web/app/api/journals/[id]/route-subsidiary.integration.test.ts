import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The journals PATCH route has a bespoke updater that bypasses the shared
// applyDocumentEdit service (fixed for subsidiary-clear in fa70ab6b3). It
// must refuse an explicit header subsidiaryId: null the same way: posting
// falls back to the root when the header is null, but every
// subsidiary-scoped list excludes null, so a cleared journal vanishes from
// restricted readers' lists while its ledger entries remain. Line-level
// nulls stay legitimate (they fall back to the header). Only the session
// gate is stubbed; the handler and storage are real.

const stateKey = Symbol.for("openbooks.journal-subsidiary-test");
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
  const state = globalThis[Symbol.for('openbooks.journal-subsidiary-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope(authz, subsidiaryId) {
    if (authz.allowedSubsidiaryIds === null) return null
    if (subsidiaryId === null || subsidiaryId === undefined) return null
    if (authz.allowedSubsidiaryIds.includes(subsidiaryId)) return null
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }
  export function subsidiariesInScope(authz, ids) {
    if (authz.allowedSubsidiaryIds === null) return true
    return ids.every((id) => authz.allowedSubsidiaryIds.includes(id))
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

const patchRouteUrl = "./route.ts?journal-subsidiary-test";
const { PATCH } = (await import(patchRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { documentRevisionCounterSql } = await import("../../../../lib/documents.ts");

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

async function revisionToken(documentId: string): Promise<string> {
  const row = (await db.execute<{ updatedAt: string }>(sql`
    select ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt"
      from documents where id = ${documentId}
  `));
  return row.rows[0]!.updatedAt;
}

test(
  "journals PATCH refuses to clear the header subsidiary",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
      // A subsidiary-restricted caller: the null-clear must be refused, not
      // waved past the scope guard (which only checks non-null ids).
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: [org.subsidiaryId],
      };
      const documentId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, subsidiary_id, document_date,
             currency, fx_rate, status, subtotal, tax_total, total, custom,
             created_by, updated_by)
          values (
            ${documentId}, ${org.orgId}, 'journal', 'JE-SUB-CLEAR-1',
            ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', 100, 0, 100,
            '{}'::jsonb, ${adminId}, ${adminId}
          )
        `);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity, unit_price,
             amount, subsidiary_id, custom, created_by, updated_by)
          values (
            ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, 1, 100,
            100, ${org.subsidiaryId}, '{}'::jsonb, ${adminId}, ${adminId}
          )
        `);
      });

      // The mocked session gate carries no connection scope; the revision
      // read, the handler, and the verification read run under the org.
      const token = await withOrgContext(org.orgId, () => revisionToken(documentId));
      const attempt = patchRequest(documentId, { subsidiaryId: null, expectedUpdatedAt: token });
      const refused = await withOrgContext(org.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.equal(refused.status, 422);
      assert.match((await refused.json() as { error: string }).error, /subsidiary/i);
      const stored = (await withOrgContext(org.orgId, () => db.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from documents where id = ${documentId}
      `)));
      assert.equal(stored.rows[0]!.subsidiary_id, org.subsidiaryId);

      // Positive control: an ordinary header edit with the same revision
      // still saves, so the refusal is the null — not the harness.
      const memo = patchRequest(documentId, { memo: "still editable", expectedUpdatedAt: token });
      const saved = await withOrgContext(org.orgId, () => PATCH(memo.req, memo.ctx));
      assert.equal(saved.status, 200);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
