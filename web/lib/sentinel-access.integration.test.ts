import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as React from "react";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null; period: { from: string; to: string; label: string } | null } = { user: null, period: null };
Object.assign(globalThis, { __sentinelAccess: state, React });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__sentinelAccess.user}" };
  if (specifier.endsWith("/lib/periods") && context.parentURL?.endsWith("/analytics/sentinel/page.tsx")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function resolvePeriod(){return globalThis.__sentinelAccess.period}" };
  }
  if (specifier.startsWith("@/")) {
    const path = root + "web/" + specifier.slice(2);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    }
    return next(path, context);
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { getAuthz } = await import("./authz");
const { sentinelData } = await import("./analytics/sentinel-data");
const { default: Sentinel } = await import("../app/(app)/analytics/sentinel/page");
const { executeAssistantTool } = await import("./assistant/registry");
const { GET: drilldown } = await import("../app/api/analytics/sentinel/benford/route");

for (const boundary of ["service", "page", "assistant", "drilldown"] as const) {
  for (const mode of ["restricted", "empty", "no audit grant", "all"] as const) {
    test(`Sentinel access ${boundary}: ${mode}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const actor = await createScratchUser(org.orgId, "Forensic reviewer", "forensic_reviewer");
        const restriction = mode === "all" || mode === "no audit grant" ? { mode: "all" }
          : { mode: "list", subsidiaryIds: mode === "empty" ? [] : [org.subsidiaryId] };
        const permissions = ["reports.read", "assistant.use", ...(mode === "no audit grant" ? [] : ["admin.audit.read"])];
        await db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb, subsidiary_restriction=${JSON.stringify(restriction)}::jsonb
          where org_id=${org.orgId} and key='forensic_reviewer'`);
        state.user = { id: actor, orgId: org.orgId, name: "Forensic reviewer", email: "forensics@scratch.test", roles: [], isSuperAdmin: false,
          envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        state.period = { from: org.date, to: org.date, label: "Audit day" };
        const hiddenSubsidiary = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values (${hiddenSubsidiary},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
        for (const [subsidiaryId, amount, number] of [[org.subsidiaryId, "100", "VISIBLE-SPEND"], [hiddenSubsidiary, "999", "HIDDEN-SPEND"]]) {
          const id = randomUUID();
          await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency)
            values (${id},${org.orgId},'customer_credit',${number},${org.date},${org.customerId},${subsidiaryId},'CAD')`);
          await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount)
            values (${org.orgId},${id},1,${org.accounts.revenue},1,${amount},${amount})`);
        }
        await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id,at)
          values (${org.orgId},'bank_accounts',${randomUUID()},'delete','{"before":{"routing":"PRIVATE-ROUTING-EVIDENCE"}}'::jsonb,${actor},${org.date}::date + interval '12 hours')`);
        await withOrgContext(org.orgId, async () => {
          const authz = await getAuthz();
          assert.ok(authz);
          const period = state.period!;
          if (boundary === "service") {
            const invoke = () => sentinelData(org.orgId, period, authz);
            if (mode === "all") assert.equal((await invoke()).meta.totalDocs, 2);
            else await assert.rejects(invoke, (error: unknown) => error instanceof Error && (error as Error & { status?: number }).status === 403);
          } else if (boundary === "page") {
            const invoke = () => Sentinel({ searchParams: Promise.resolve({}) });
            if (mode === "all") {
              const output = JSON.stringify(await invoke(), (_key, value: unknown) => React.isValidElement(value) ? value.props : value);
              assert.ok(output.includes("HIDDEN-SPEND"));
              assert.ok(output.includes("PRIVATE-ROUTING-EVIDENCE"));
            } else await assert.rejects(invoke, (error: unknown) => error instanceof Error && error.message.includes("NEXT_REDIRECT"));
          } else if (boundary === "assistant") {
            const result = await executeAssistantTool(authz, "analytics_sentinel", { fromDate: period.from, toDate: period.to });
            if (mode === "all") {
              assert.equal(result.ok, true);
              assert.ok(JSON.stringify(result).includes("PRIVATE-ROUTING-EVIDENCE"));
            } else assert.deepEqual(result, { ok: false, error: "forbidden" });
          } else {
            const response = await drilldown(new Request(`http://audit.local/api/analytics/sentinel/benford?digit=9&from=${period.from}&to=${period.to}`));
            assert.equal(response.status, 200);
            const data = await response.json();
            const visible = mode === "all" || mode === "no audit grant";
            assert.equal(data.count, visible ? 1 : 0);
            assert.equal(data.documents.length, visible ? 1 : 0);
            if (visible) assert.equal(data.documents[0].docNumber, "HIDDEN-SPEND");
          }
        });
      } finally {
        state.user = null;
        state.period = null;
        await dropScratchOrg(org.orgId);
      }
    });
  }
}
