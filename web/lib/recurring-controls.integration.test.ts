import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __recurringControlUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__recurringControlUser.user}" };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { withSimClock } = await import("@openbooks/engine/src/clock.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { runScheduleNow } = await import("@openbooks/engine/src/recurring.ts");
const collection = await import("../app/api/recurring/route");
const detail = await import("../app/api/recurring/[id]/route");
const request = (method: string, body?: unknown) => new Request("http://audit.local/api/recurring", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

for (const operation of ["list", "create by id", "create by number", "edit", "delete", "run", "enable posting", "coerced posting", "run posting", "coerced active", "reactivate posting", "reschedule posting", "invalid date", "invalid cron", "direct hidden", "direct no permission", "direct post denied", "empty scope", "subtree scope", "unrestricted scope", "authorized lifecycle"] as const) {
  test(`recurring controls: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Recurring manager", "recurring_manager");
      const hidden = randomUUID();
      await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country)
        values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden subsidiary','CAD','CA')`);
      await db.execute(sql`update app_roles set permissions='["documents.manage"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
        where org_id=${org.orgId} and key='recurring_manager'`);
      state.user = { id: actor, orgId: org.orgId, name: "Recurring manager", email: "recurring@scratch.test", roles: [],
        isSuperAdmin: false, envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const templates = [randomUUID(), randomUUID()], schedules = [randomUUID(), randomUUID()];
      for (let index = 0; index < 2; index++) {
        await db.execute(sql`insert into documents (id,org_id,kind,status,document_number,document_date,currency,party_id,subsidiary_id,created_by)
          values (${templates[index]!},${org.orgId},'customer_invoice','draft',${`RECUR-${index}`},${org.date},'CAD',${org.customerId},${index ? hidden : org.subsidiaryId},${actor})`);
        await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
          values (${org.orgId},${templates[index]!},1,${org.accounts.revenue},'1','100','100','0')`);
        await db.execute(sql`insert into recurring_schedules (id,org_id,template_document_id,cadence,next_run_on,auto_post,is_active,created_by)
          values (${schedules[index]!},${org.orgId},${templates[index]!},'monthly',${org.date},false,true,${actor})`);
      }
      const hiddenParams = { params: Promise.resolve({ id: schedules[1]! }) };
      const visibleParams = { params: Promise.resolve({ id: schedules[0]! }) };
      await withOrgContext(org.orgId, () => withSimClock(org.date, async () => {
        if (operation === "empty scope" || operation === "subtree scope" || operation === "unrestricted scope") {
          const restriction = operation === "empty scope" ? { mode: "list", subsidiaryIds: [] }
            : operation === "subtree scope" ? { mode: "subtree", subsidiaryId: org.subsidiaryId } : null;
          await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify(restriction)}::jsonb
            where org_id=${org.orgId} and key='recurring_manager'`);
          const response = await collection.GET();
          assert.equal(response.status, 200);
          assert.deepEqual(new Set((await response.json()).schedules.map((row: { id: string }) => row.id)),
            new Set(operation === "empty scope" ? [] : schedules));
          if (operation === "empty scope") assert.equal((await detail.POST(request("POST"), visibleParams)).status, 404);
          return;
        }
        if (operation === "direct hidden" || operation === "direct no permission" || operation === "direct post denied") {
          if (operation === "direct no permission") await db.execute(sql`update app_roles set permissions='[]'::jsonb
            where org_id=${org.orgId} and key='recurring_manager'`);
          if (operation === "direct post denied") {
            await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb where org_id=${org.orgId} and key='recurring_manager'`);
            await db.execute(sql`insert into user_permission_overrides (org_id,user_id,permission,effect) values (${org.orgId},${actor},'gl.post','deny')`);
            await db.execute(sql`update recurring_schedules set auto_post=true where id=${schedules[0]!}`);
          }
          await assert.rejects(() => runScheduleNow(schedules[operation === "direct hidden" ? 1 : 0]!, actor, org.date),
            { status: operation === "direct hidden" ? 404 : 403 });
          assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId}`)).rows[0]!.n, 2);
          return;
        }
        if (operation === "authorized lifecycle") {
          await db.execute(sql`update app_roles set permissions='["documents.manage","gl.post"]'::jsonb
            where org_id=${org.orgId} and key='recurring_manager'`);
          const created = await collection.POST(request("POST", { templateDocumentId: templates[0], cadence: "monthly", nextRunOn: org.date, autoPost: true, name: "Authorized recurrence" }));
          assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
          const id = (await created.json()).id;
          const params = { params: Promise.resolve({ id }) };
          assert.equal((await detail.PATCH(request("PATCH", { name: "Renamed recurrence" }), params)).status, 200);
          const first = await detail.POST(request("POST"), params);
          assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
          const generated = await first.json();
          assert.equal(generated.posted, true);
          const second = await detail.POST(request("POST"), params);
          assert.equal((await second.json()).documentId, generated.documentId);
          assert.equal((await detail.DELETE(request("DELETE"), params)).status, 409);
          assert.equal((await detail.DELETE(request("DELETE"), visibleParams)).status, 200);
          const audits = (await db.execute<{ action: string }>(sql`select action from audit_log
            where org_id=${org.orgId} and table_name='recurring_schedules' and row_id=${id} order by at`)).rows;
          assert.deepEqual(audits.map(row => row.action), ["insert", "update"]);
          return;
        }
        if (operation === "list") {
          const response = await collection.GET();
          assert.equal(response.status, 200);
          assert.deepEqual((await response.json()).schedules.map((row: { id: string }) => row.id), [schedules[0]]);
          return;
        }
        let response: Response;
        let expected = 404;
        if (operation === "coerced active" || operation === "invalid date") {
          response = await detail.PATCH(request("PATCH", operation === "coerced active" ? { isActive: "false" } : { nextRunOn: "2026-02-30" }), visibleParams);
          expected = 400;
        } else if (operation === "invalid cron") {
          response = await collection.POST(request("POST", { templateDocumentId: templates[0], cadence: "custom_cron", cron: "not a cron", nextRunOn: org.date }));
          expected = 400;
        } else if (operation === "reactivate posting" || operation === "reschedule posting") {
          await db.execute(sql`update recurring_schedules set auto_post=true,is_active=false where id=${schedules[0]!}`);
          response = await detail.PATCH(request("PATCH", operation === "reactivate posting" ? { isActive: true } : { nextRunOn: org.date }), visibleParams);
          expected = 403;
        } else if (operation === "create by id" || operation === "create by number") {
          response = await collection.POST(request("POST", { cadence: "monthly", nextRunOn: org.date,
            ...(operation === "create by id" ? { templateDocumentId: templates[1] } : { templateDocumentNumber: "RECUR-1" }) }));
        } else if (operation === "edit") response = await detail.PATCH(request("PATCH", { name: "Hidden edit" }), hiddenParams);
        else if (operation === "delete") response = await detail.DELETE(request("DELETE"), hiddenParams);
        else if (operation === "run") response = await detail.POST(request("POST"), hiddenParams);
        else if (operation === "run posting") {
          await db.execute(sql`update recurring_schedules set auto_post=true where id=${schedules[0]!} and org_id=${org.orgId}`);
          response = await detail.POST(request("POST"), visibleParams);
          expected = 403;
        } else {
          response = await detail.PATCH(request("PATCH", { autoPost: operation === "coerced posting" ? "false" : true }), visibleParams);
          expected = operation === "coerced posting" ? 400 : 403;
        }
        assert.equal(response.status, expected, JSON.stringify(await response.json()));
        assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId}`)).rows[0]!.n, 2);
        assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from recurring_schedules where org_id=${org.orgId}`)).rows[0]!.n, 2);
      }));
    } finally { state.user = null; await dropScratchOrg(org.orgId); }
  });
}
