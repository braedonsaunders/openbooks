import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { resolveAppModule } from "./test-module-hooks";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as React from "react";
import type { SessionUser } from "./auth";
import { stubModules } from "../testing/stub-modules.ts";

const root = pathToFileURL(process.cwd() + "/").href;
const state: {
  user: SessionUser | null;
  period: { from: string; to: string; label: string } | null;
} = { user: null, period: null };
Object.assign(globalThis, { __sentinelAccess: state, React });
stubModules({
  navigation: false,
  intl: "export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'};export async function getFormatter(){return {dateTime:date=>date.toISOString()}}",
  authz: false,
  features: false,
});

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__sentinelAccess.user}",
      };
    if (
      specifier.endsWith("/lib/periods") &&
      /\/analytics\/sentinel\/(?:page\.tsx|view\.ts)$/.test(context.parentURL ?? "")
    ) {
      // Re-export the real period module and override only the clock: a
      // hand copy would go stale on the next export the graph gains (it just
      // did — MissingAccountingPeriodError), failing the file to link with
      // zero tests instead of failing loudly.
      const realPeriods = new URL("./periods.ts", import.meta.url).href;
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export * from ${JSON.stringify(realPeriods)}; export async function resolvePeriod(){return globalThis.__sentinelAccess.period}`,
          ),
      };
    }
    const app = resolveAppModule(specifier, context, next, root);
    if (app) return app;
    return next(specifier, context);
  },
});
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { getAuthz } = await import("./authz");
const { sentinelData } = await import("./analytics/sentinel-data");
const { default: Sentinel } = await import("../app/(app)/analytics/sentinel/page");
const { executeAssistantTool } = await import("./assistant/registry");
const { GET: drilldown } = await import("../app/api/analytics/sentinel/benford/route");

for (const boundary of ["service", "page", "assistant", "drilldown"] as const) {
  for (const mode of [
    "restricted",
    "empty",
    "no audit grant",
    "no expense grant",
    "all",
  ] as const) {
    test(
      `Sentinel access ${boundary}: ${mode}`,
      { skip: !process.env.OPENBOOKS_DB_URL },
      async () => {
        const org = await withBypassContext(() => createScratchOrg());
        try {
          const actor = await withBypassContext(() =>
            createScratchUser(org.orgId, "Forensic reviewer", "forensic_reviewer"),
          );
          const restriction =
            mode === "all" || mode === "no audit grant" || mode === "no expense grant"
              ? { mode: "all" }
              : { mode: "list", subsidiaryIds: mode === "empty" ? [] : [org.subsidiaryId] };
          // Sentinel's spend evidence includes every employee's expense reports.
          const permissions = [
            "reports.read",
            "assistant.use",
            ...(mode === "no audit grant" ? [] : ["admin.audit.read"]),
            ...(mode === "no expense grant" ? [] : ["expenses.read"]),
          ];
          await withBypassContext(() =>
            db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb, subsidiary_restriction=${JSON.stringify(restriction)}::jsonb
          where org_id=${org.orgId} and key='forensic_reviewer'`),
          );
          state.user = {
            id: actor,
            orgId: org.orgId,
            name: "Forensic reviewer",
            email: "forensics@scratch.test",
            roles: [],
            isSuperAdmin: false,
            envKind: "production",
            productionOrgId: org.orgId,
            homeOrgId: org.orgId,
            homeUserId: actor,
          };
          state.period = { from: org.date, to: org.date, label: "Audit day" };
          const hiddenSubsidiary = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
            values (${hiddenSubsidiary},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
            for (const [subsidiaryId, amount, number] of [
              [org.subsidiaryId, "100", "VISIBLE-SPEND"],
              [hiddenSubsidiary, "999", "HIDDEN-SPEND"],
            ]) {
              const id = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency)
              values (${id},${org.orgId},'customer_credit',${number},${org.date},${org.customerId},${subsidiaryId},'CAD')`);
              await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount)
              values (${org.orgId},${id},1,${org.accounts.revenue},1,${amount},${amount})`);
            }
            await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id,at)
            values (${org.orgId},'bank_accounts',${randomUUID()},'delete','{"before":{"routing":"PRIVATE-ROUTING-EVIDENCE"}}'::jsonb,${actor},${org.date}::date + interval '12 hours')`);
          });
          await withOrgContext(org.orgId, async () => {
            const authz = await getAuthz();
            assert.ok(authz);
            const period = state.period!;
            if (boundary === "service") {
              const invoke = () => sentinelData(org.orgId, period, authz);
              if (mode === "all") assert.equal((await invoke()).meta.totalDocs, 2);
              else
                await assert.rejects(
                  invoke,
                  (error: unknown) =>
                    error instanceof Error && (error as Error & { status?: number }).status === 403,
                );
            } else if (boundary === "page") {
              const invoke = (tab?: string) =>
                Sentinel({ searchParams: Promise.resolve(tab ? { tab } : {}) });
              if (mode === "all") {
                const render = async (tab?: string) =>
                  JSON.stringify(await invoke(tab), (_key, value: unknown) =>
                    React.isValidElement(value) ? value.props : value,
                  );
                // The page totals both subsidiaries' documents (100 + 999).
                const overview = await render();
                assert.ok(
                  overview.includes('"totalDocs":2') &&
                    overview.includes('"totalAmount":"1099.0000"'),
                );
                // Sections load per tab. The Audit tab's trail is a one-line
                // summary (table + verb); the raw routing secret never reaches the page.
                const audit = await render("audit");
                assert.ok(audit.includes("bank_accounts"));
                assert.ok(!audit.includes("PRIVATE-ROUTING-EVIDENCE"));
              } else
                await assert.rejects(
                  invoke,
                  (error: unknown) =>
                    error instanceof Error && error.message.includes("NEXT_REDIRECT"),
                );
            } else if (boundary === "assistant") {
              const result = await executeAssistantTool(authz, "analytics_sentinel", {
                fromDate: period.from,
                toDate: period.to,
              });
              if (mode === "all") {
                assert.equal(result.ok, true);
                const payload = JSON.stringify(result);
                assert.ok(payload.includes("bank_accounts"));
                assert.ok(!payload.includes("PRIVATE-ROUTING-EVIDENCE"));
              } else assert.deepEqual(result, { ok: false, error: "forbidden" });
            } else {
              const response = await drilldown(
                new Request(
                  `http://audit.local/api/analytics/sentinel/benford?digit=9&from=${period.from}&to=${period.to}`,
                ),
              );
              // The drill shares the page's whole-company gate: anything less
              // than unrestricted reports + audit access is a 403, never
              // filtered rows — a reports-only role sees nothing at all.
              if (mode === "all") {
                assert.equal(response.status, 200);
                const data = await response.json();
                assert.equal(data.count, 1);
                assert.equal(data.documents.length, 1);
                assert.equal(data.documents[0].docNumber, "HIDDEN-SPEND");
              } else {
                assert.equal(response.status, 403, `drilldown must refuse ${mode}`);
                const data = (await response.json()) as { error: string; message: string };
                assert.equal(data.error, "forbidden");
                assert.ok(
                  data.message.includes(
                    mode === "no expense grant"
                      ? "expenses.read"
                      : mode === "no audit grant"
                        ? "admin.audit.read"
                        : "unrestricted subsidiary access",
                  ),
                  `refusal must name the missing requirement, got: ${data.message}`,
                );
              }
            }
          });
        } finally {
          state.user = null;
          state.period = null;
          await dropScratchOrg(org.orgId);
        }
      },
    );
  }
}
