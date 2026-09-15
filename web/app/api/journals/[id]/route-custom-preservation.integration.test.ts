import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Journals PATCH has a bespoke updater (not the shared applyDocumentEdit
// service fixed for expense/project/item/party/account/asset). It validates
// body.custom alone and coalesces the cleaned subset over the whole custom
// column: a partial edit omitting a required header field is spuriously
// rejected, and a successful partial save wipes omitted custom metadata.
// Only the session gate is stubbed; the handler and storage are real.

const stateKey = Symbol.for("openbooks.journal-custom-test");
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
  const state = globalThis[Symbol.for('openbooks.journal-custom-test')]
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

const patchRouteUrl = "./route.ts?journal-custom-test";
const { PATCH } = (await import(patchRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { documentRevisionSql } = await import("../../../../lib/documents.ts");

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
    select ${documentRevisionSql(sql.raw("updated_at"))} as "updatedAt"
      from documents where id = ${documentId}
  `));
  return row.rows[0]!.updatedAt;
}

test(
  "journals PATCH preserves omitted required header custom fields on a partial edit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      await db.execute(sql`
        insert into custom_field_defs
          (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
        values
          (${randomUUID()}, ${org.orgId}, 'documents', 'journal', 'required_code', 'Required code', 'text', '{}'::jsonb, true, true, ${adminId}, ${adminId}),
          (${randomUUID()}, ${org.orgId}, 'documents', 'journal', 'optional_note', 'Optional note', 'text', '{}'::jsonb, false, true, ${adminId}, ${adminId})
      `);
      const documentId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, subsidiary_id, document_date,
           currency, fx_rate, status, subtotal, tax_total, total, custom,
           created_by, updated_by)
        values (
          ${documentId}, ${org.orgId}, 'journal', 'JE-CUSTOM-1',
          ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', 100, 0, 100,
          '{"required_code":"R-1"}'::jsonb, ${adminId}, ${adminId}
        )
      `);
      const token = await revisionToken(documentId);
      const attempt = patchRequest(documentId, {
        expectedUpdatedAt: token,
        custom: { optional_note: "updated" },
      });
      const saved = await PATCH(attempt.req, attempt.ctx);
      assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
      const stored = (await db.execute<{ custom: Record<string, unknown> }>(sql`
        select custom from documents where id = ${documentId} and org_id = ${org.orgId}
      `)).rows[0]?.custom;
      assert.deepEqual(stored, { required_code: "R-1", optional_note: "updated" });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
