import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// OM-09b: journals PATCH must refuse a contentful leg without an account
// with a 422 naming the line — and write nothing. The zod boundary used to
// reject a blank accountId with an anonymous uuid failure (and the drawers
// dropped the leg before it ever arrived); the handler now names the line.
// Only the session gate is stubbed; handler and storage are real.

const stateKey = Symbol.for("openbooks.journal-accountless-test");
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
  const state = globalThis[Symbol.for('openbooks.journal-accountless-test')]
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

const patchRouteUrl = "./route.ts?journal-accountless-test";
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

async function seedDraftJournal(org: { orgId: string; subsidiaryId: string; date: string }, actorId: string): Promise<string> {
  const documentId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       currency, fx_rate, status, subtotal, tax_total, total, custom,
       created_by, updated_by)
    values (
      ${documentId}, ${org.orgId}, 'journal', 'JE-OM09B-1',
      ${org.subsidiaryId}, ${org.date}, 'CAD', 1, 'draft', 100, 0, 100,
      '{}'::jsonb, ${actorId}, ${actorId}
    )
  `));
  return documentId;
}

async function storedState(orgId: string, documentId: string): Promise<{ total: string; n: number; amounts: string[] }> {
  const doc = (await withOrgContext(orgId, () => db.execute<{ total: string }>(sql`
    select total::text as total from documents where id = ${documentId} and org_id = ${orgId}
  `))).rows[0]!;
  const lines = (await withOrgContext(orgId, () => db.execute<{ amount: string }>(sql`
    select amount::text as amount from document_lines
     where document_id = ${documentId} and org_id = ${orgId} order by line_number
  `))).rows;
  return { total: doc.total, n: lines.length, amounts: lines.map((l) => l.amount) };
}

test(
  "journals PATCH refuses an account-less contentful leg with its line number and writes nothing",
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
      const documentId = await seedDraftJournal(org, adminId);
      const attempt = patchRequest(documentId, {
        expectedUpdatedAt: await revisionToken(org.orgId, documentId),
        lines: [
          { accountId: org.accounts.cogs, amount: "100", description: "leg one" },
          { accountId: "", amount: "100", description: "mystery leg" },
          { accountId: org.accounts.bank, amount: "-200", description: "leg three" },
        ],
      });
      const refused = await withOrgContext(org.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.equal(refused.status, 422, `expected 422, got ${refused.status}`);
      const body = (await refused.json()) as { error?: unknown };
      assert.match(
        String(body.error ?? ""),
        /Line 2: an account is required/,
        "the refusal must name the offending leg and the remedy",
      );
      assert.deepEqual(await storedState(org.orgId, documentId), {
        total: "100.0000",
        n: 0,
        amounts: [],
      });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "journals PATCH refuses a malformed line account with its line number",
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
      const documentId = await seedDraftJournal(org, adminId);
      const attempt = patchRequest(documentId, {
        expectedUpdatedAt: await revisionToken(org.orgId, documentId),
        lines: [
          { accountId: org.accounts.cogs, amount: "100", description: "leg one" },
          { accountId: "not-a-uuid", amount: "-100", description: "leg two" },
        ],
      });
      const refused = await withOrgContext(org.orgId, () => PATCH(attempt.req, attempt.ctx));
      assert.equal(refused.status, 422, `expected 422, got ${refused.status}`);
      const body = (await refused.json()) as { error?: unknown };
      assert.match(
        String(body.error ?? ""),
        /Line 2: invalid account/,
        "a malformed account must name the line instead of failing anonymously at the boundary",
      );
      assert.deepEqual(await storedState(org.orgId, documentId), {
        total: "100.0000",
        n: 0,
        amounts: [],
      });
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
