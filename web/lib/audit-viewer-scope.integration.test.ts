import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as React from "react";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
// The plain tsx runner uses classic JSX for this RSC source; Next supplies
// the automatic JSX runtime in production.
Object.assign(globalThis, { __auditViewerSession: session, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__auditViewerSession.user}" };
  if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { default: Audit } = await import("../app/(app)/admin/audit/page");

const cases: Array<{ mode: "restricted" | "empty" | "all"; query?: Record<string, string>; invalid?: boolean }> = [
  { mode: "restricted" }, { mode: "empty" }, { mode: "all" },
  { mode: "all", query: { actor: "not-a-uuid" }, invalid: true },
  { mode: "all", query: { from: "not-a-date" }, invalid: true },
  { mode: "all", query: { to: "2026-02-30" }, invalid: true },
  { mode: "all", query: { from: "2026-01-01", to: "2026-12-31" } },
];
for (const { mode, query = {}, invalid = false } of cases) {
  test(`company audit viewer scope: ${mode} ${JSON.stringify(query)}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Scoped auditor", "audit_reviewer");
      const restriction = mode === "all" ? { mode: "all" } : { mode: "list", subsidiaryIds: mode === "empty" ? [] : [org.subsidiaryId] };
      await db.execute(sql`update app_roles set permissions='["admin.audit.read"]'::jsonb, subsidiary_restriction=${JSON.stringify(restriction)}::jsonb
        where org_id=${org.orgId} and key='audit_reviewer'`);
      session.user = { id: actor, orgId: org.orgId, name: "Scoped auditor", email: "auditor@scratch.test", roles: [], isSuperAdmin: false,
        envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const hiddenSubsidiary = randomUUID();
      const eventId = randomUUID();
      // A deleted document has no live row from which to infer visibility.
      // Its retained snapshot and even its presence/count remain disclosures.
      const evidence = { before: { document: { id: randomUUID(), subsidiary_id: hiddenSubsidiary,
        kind: "customer_invoice", number: "PRIVATE-AUDIT-DOCUMENT" }, lines: [{ amount: "98765.4300" }] } };
      await db.execute(sql`insert into audit_log(id,org_id,table_name,row_id,action,changes,actor_id)
        values (${eventId},${org.orgId},'documents',${evidence.before.document.id},'delete',${JSON.stringify(evidence)}::jsonb,${actor})`);
      const invoke = () => withOrgContext(org.orgId, () => Audit({ searchParams: Promise.resolve({ event: eventId, ...query }) }));
      if (mode === "all" && !invalid) {
        const output = JSON.stringify(await invoke(), (_key, value: unknown) => React.isValidElement(value) ? value.props : value);
        assert.ok(output.includes("PRIVATE-AUDIT-DOCUMENT"));
        assert.ok(output.includes("98765.4300"));
      } else {
        await assert.rejects(invoke, (error: unknown) => error instanceof Error &&
          (error.message.includes("NEXT_REDIRECT") || error.message.includes("NEXT_HTTP_ERROR_FALLBACK;404")));
      }
    } finally {
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}
