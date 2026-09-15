import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Journals PATCH regression: the header documentDate is calendar-validated by
// the shared zod isoDate boundary (zod v4's date regex encodes month lengths
// and leap years, so '2026-02-30' fails closed as 422 — pinned by the first
// test), but header/line party references were never verified for org
// ownership, so a well-formed foreign-org party died at the tenant-coherent
// FK as a raw storage 500. The line-account precheck (926a38886) covered
// only accounts. Only the session gate is stubbed; handler and storage are
// real.

const stateKey = Symbol.for("openbooks.journal-header-refs-test");
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
  const state = globalThis[Symbol.for('openbooks.journal-header-refs-test')]
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

const patchRouteUrl = "./route.ts?journal-header-refs-test";
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

async function makeDraftJournal(org: { orgId: string; subsidiaryId: string; date: string }, adminId: string, n: string) {
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       currency, fx_rate, status, subtotal, tax_total, total, custom,
       created_by, updated_by)
    values (
      ${documentId}, ${org.orgId}, 'journal', ${n},
      ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', 100, 0, 100,
      '{}'::jsonb, ${adminId}, ${adminId}
    )
  `);
  return documentId;
}

test(
  "journals PATCH refuses an impossible header document date with a domain error",
  { skip: !DB },
  async () => {
    const orgA = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(orgA.orgId);
      routeState.authz = {
        user: { orgId: orgA.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const documentId = await makeDraftJournal(orgA, adminId, "JE-BAD-DATE-1");
      const token = await revisionToken(documentId);
      const attempt = patchRequest(documentId, { expectedUpdatedAt: token, documentDate: "2026-02-30" });
      const refused = await PATCH(attempt.req, attempt.ctx);
      assert.ok(
        refused.status === 400 || refused.status === 422,
        `expected a domain 4xx, got ${refused.status}`,
      );
      const date = (await db.execute<{ d: string }>(sql`
        select document_date::text as d from documents where id = ${documentId}
      `)).rows[0]!.d;
      assert.equal(date, orgA.date, "refused date writes nothing");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(orgA.orgId);
    }
  },
);

test(
  "journals PATCH refuses a foreign-org line party with a domain error",
  { skip: !DB },
  async () => {
    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(orgA.orgId);
      routeState.authz = {
        user: { orgId: orgA.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const documentId = await makeDraftJournal(orgA, adminId, "JE-ALIEN-PARTY-1");
      const token = await revisionToken(documentId);
      // orgB's real customer: well-formed, active, but another tenant's.
      const attempt = patchRequest(documentId, {
        expectedUpdatedAt: token,
        lines: [{ accountId: orgA.accounts.cogs, amount: "100", partyId: orgB.customerId }],
      });
      const refused = await PATCH(attempt.req, attempt.ctx);
      assert.ok(
        refused.status === 404 || refused.status === 422,
        `expected a domain 4xx, got ${refused.status}`,
      );
      const lines = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_lines where document_id = ${documentId} and org_id = ${orgA.orgId}
      `)).rows[0]!.n;
      assert.equal(lines, 0, "refused foreign-party lines store nothing");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);

test(
  "journals PATCH refuses a foreign-org header party with a domain error",
  { skip: !DB },
  async () => {
    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(orgA.orgId);
      routeState.authz = {
        user: { orgId: orgA.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const documentId = await makeDraftJournal(orgA, adminId, "JE-ALIEN-HDR-1");
      const token = await revisionToken(documentId);
      const attempt = patchRequest(documentId, { expectedUpdatedAt: token, partyId: orgB.customerId });
      const refused = await PATCH(attempt.req, attempt.ctx);
      assert.ok(
        refused.status === 404 || refused.status === 422,
        `expected a domain 4xx, got ${refused.status}`,
      );
      const party = (await db.execute<{ p: string | null }>(sql`
        select party_id as p from documents where id = ${documentId}
      `)).rows[0]!.p;
      assert.equal(party, null, "refused header party writes nothing");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);

test(
  "journals PATCH refuses foreign reference custom values on header and lines",
  { skip: !DB },
  async () => {
    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(orgA.orgId);
      routeState.authz = {
        user: { orgId: orgA.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const documentId = await makeDraftJournal(orgA, adminId, "JE-ALIEN-CF-1");
      await db.execute(sql`
        insert into custom_field_defs
          (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
        values
          (${randomUUID()}, ${orgA.orgId}, 'documents', 'journal', 'ref_party', 'Reference party', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${adminId}, ${adminId}),
          (${randomUUID()}, ${orgA.orgId}, 'document_lines', 'journal', 'line_ref', 'Line reference', 'reference', '{"referenceTable":"parties"}'::jsonb, false, true, ${adminId}, ${adminId})
      `);
      const headerAttempt = patchRequest(documentId, {
        expectedUpdatedAt: await revisionToken(documentId),
        custom: { ref_party: orgB.customerId },
      });
      const refusedHeader = await PATCH(headerAttempt.req, headerAttempt.ctx);
      assert.equal(
        refusedHeader.status,
        404,
        `expected tenant-opaque 404, got ${refusedHeader.status}: ${JSON.stringify(await refusedHeader.clone().json().catch(() => null))}`,
      );
      const storedCustom = (await db.execute<{ custom: Record<string, unknown> }>(sql`
        select custom from documents where id = ${documentId}
      `)).rows[0]!.custom;
      assert.equal(
        (storedCustom as Record<string, unknown> | undefined)?.ref_party,
        undefined,
        "refused header references store nothing",
      );
      const savedHeader = patchRequest(documentId, {
        expectedUpdatedAt: await revisionToken(documentId),
        custom: { ref_party: orgA.customerId },
      });
      assert.equal((await PATCH(savedHeader.req, savedHeader.ctx)).status, 200, "own-org header reference must stay green");
      const lineAttempt = patchRequest(documentId, {
        expectedUpdatedAt: await revisionToken(documentId),
        lines: [{ accountId: orgA.accounts.cogs, amount: "100", custom: { line_ref: orgB.customerId } }],
      });
      const refusedLine = await PATCH(lineAttempt.req, lineAttempt.ctx);
      assert.equal(
        refusedLine.status,
        404,
        `expected tenant-opaque 404, got ${refusedLine.status}: ${JSON.stringify(await refusedLine.clone().json().catch(() => null))}`,
      );
      const lines = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_lines where document_id = ${documentId} and org_id = ${orgA.orgId}
      `)).rows[0]!.n;
      assert.equal(lines, 0, "refused line references store nothing");
      const savedLine = patchRequest(documentId, {
        expectedUpdatedAt: await revisionToken(documentId),
        lines: [{ accountId: orgA.accounts.cogs, amount: "100", custom: { line_ref: orgA.customerId } }],
      });
      assert.equal((await PATCH(savedLine.req, savedLine.ctx)).status, 200, "own-org line reference must stay green");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);
