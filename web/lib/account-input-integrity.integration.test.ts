import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __accountInputSession: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__accountInputSession.user}" };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PATCH } = await import("../app/api/accounts/[id]/route");
const { POST } = await import("../app/api/accounts/route");

const invalidInputs: Array<[string, Record<string, unknown>]> = [
  ["numeric number", { number: 123 }],
  ["object name", { name: {} }],
  ["object description", { description: {} }],
  ["object parent", { parentId: {} }],
  ["object currency", { currencyRestriction: {} }],
  ["object subsidiary", { subsidiaryId: {} }],
  ["string summary", { isSummary: "true" }],
  ["string activation", { isActive: "false" }],
  ["string elimination", { eliminate: "true" }],
  ["numeric descendants", { subsidiaryIncludeChildren: 0 }],
  ["string reconciliation", { reconcilable: "true" }],
  ["string monetary", { monetary: "false" }],
  ["null activation", { isActive: null }],
  ["array custom", { custom: [] }],
];
for (const method of ["POST", "PATCH"] as const) {
  for (const [label, fields] of [...invalidInputs, ["valid edit", { name: "Reviewed account", description: "Reviewed", monetary: false }],
    ["explicit clear", { number: null, description: "", parentId: null, currencyRestriction: null, subsidiaryId: null, monetary: null }]] as Array<[string, Record<string, unknown>]>) {
    test(`account input integrity ${method}: ${label}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = await createScratchUser(org.orgId, "Account controller", "reviewer");
        await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"multiCurrency":true,"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`);
        session.user = { id: actor, orgId: org.orgId, name: "Account controller", email: "account@scratch.test", roles: [], isSuperAdmin: false,
          envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        const id = randomUUID();
        if (method === "PATCH") {
          await db.execute(sql`insert into accounts(id,org_id,number,name,type,description,currency_restriction,subsidiary_id,monetary)
            values (${id},${org.orgId},'AUDIT-1','Original account','asset_other','Original description','CAD',${org.subsidiaryId},true)`);
        }
        const before = (await db.execute(sql`select * from accounts where id=${id}`)).rows[0];
        const body = method === "POST" ? { name: "New account", type: "asset_other", ...fields } : fields;
        const invoke = () => withOrgContext(org.orgId, () => {
          const request = new Request("http://audit.local/api/accounts/" + id, {
            method, headers: { "Idempotency-Key": id }, body: JSON.stringify(body),
          });
          return method === "POST" ? POST(request) : PATCH(request, { params: Promise.resolve({ id }) });
        });
        const response = await invoke();
        const accepted = label === "valid edit" || label === "explicit clear";
        const responseBody = await response.json();
        if (accepted) assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(responseBody));
        else assert.ok(response.status === 400 || response.status === 422, `expected validation refusal, got ${response.status}: ${JSON.stringify(responseBody)}`);
        const after = (await db.execute(sql`select * from accounts where id=${id}`)).rows[0];
        if (!accepted) assert.deepEqual(after, before, "malformed input cannot change account policy");
        else if (label === "valid edit") {
          assert.equal(after?.name, "Reviewed account");
          assert.equal(after?.monetary, false);
          if (method === "PATCH") assert.equal(after?.currency_restriction, "CAD");
        } else {
          for (const field of ["number", "description", "parent_id", "currency_restriction", "subsidiary_id", "monetary"]) assert.equal(after?.[field], null, field);
        }
        if (accepted && method === "POST") {
          assert.equal((await invoke()).status, 200, "exact create replay stays idempotent");
        }
        const audits = (await db.execute<{ n: number }>(sql`select count(*)::int as n from audit_log
          where org_id=${org.orgId} and table_name='accounts' and row_id=${id}`)).rows[0]!.n;
        assert.equal(audits, accepted ? 1 : 0);
      } finally {
        session.user = null;
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
