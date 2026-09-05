import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { SessionUser } from "./auth";

const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __payrollProfileSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next-intl/server") return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__payrollProfileSession.user}" };
  if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { sealSecret } = await import("@openbooks/engine/src/secrets.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("../app/api/payroll/profiles/route");

const cases: Array<[string, Record<string, unknown>]> = [
  ["create audit", {}], ["edit audit", { federalClaimAmount: "1234.56" }], ["audit failure", { federalClaimAmount: "1234.56" }],
  ["string tax exemption", { taxExempt: "false" }], ["invalid pay basis", { payBasis: "weekly" }],
  ["invalid vacation method", { vacationMethod: "weekly" }], ["object SIN", { sin: {} }],
  ["numeric SIN", { sin: 123456789 }], ["boolean claim code", { federalClaimCode: true }],
  ["boolean allowances", { w4Allowances: true }], ["string activation", { isActive: "false" }],
  ["explicit clear", { sin: null, federalClaimCode: "", vacationPercent: null }],
  ["concurrent create", {}],
  ["inherited country name", { country: "constructor" }],
];

function auditSnapshot(row: Record<string, unknown> | undefined) {
  if (!row) return undefined;
  const { sin_encrypted, ...rest } = row;
  return { ...rest, sin_present: sin_encrypted !== null };
}

for (const [label, fields] of cases) {
  test(`payroll profile integrity: ${label}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const trigger = "profile_audit_" + randomUUID().replaceAll("-", "");
    let triggerInstalled = false;
    try {
      const actor = await createScratchUser(org.orgId, "Payroll controller", "reviewer");
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}','{"payroll":true}'::jsonb) where id=${org.orgId}`);
      session.user = { id: actor, orgId: org.orgId, name: "Payroll controller", email: "payroll@scratch.test", roles: [], isSuperAdmin: false,
        envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
      const employeeId = randomUUID();
      const scheduleId = randomUUID();
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
        values (${employeeId},${org.orgId},'person','Payroll fixture',${org.subsidiaryId})`);
      await db.execute(sql`insert into employee_roles(org_id,party_id) values (${org.orgId},${employeeId})`);
      await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,subsidiary_id)
        values (${scheduleId},${org.orgId},'Review schedule','biweekly',26,'2026-07-18',${org.subsidiaryId})`);
      if (label !== "create audit" && label !== "concurrent create") await db.execute(sql`
        insert into employee_payroll_profiles(org_id,employee_party_id,pay_schedule_id,country,province,pay_basis,vacation_method,
          federal_claim_code,federal_claim_amount,tax_exempt,sin_encrypted,sin_last3)
        values (${org.orgId},${employeeId},${scheduleId},'CA','ON','salary','pay_each_period',1,'1000',true,${sealSecret("123456789")},'789')`);
      const before = (await db.execute(sql`select * from employee_payroll_profiles where employee_party_id=${employeeId}`)).rows[0];
      if (label === "audit failure") {
        await db.execute(sql.raw(`create function public."${trigger}"() returns trigger language plpgsql as $$
          begin
            if new.org_id='${org.orgId}'::uuid and new.table_name='employee_payroll_profiles' then
              raise exception 'forced payroll profile audit failure';
            end if;
            return new;
          end $$`));
        triggerInstalled = true;
        await db.execute(sql.raw(`create trigger "${trigger}" before insert on audit_log for each row execute function public."${trigger}"()`));
      }
      const body = { employeePartyId: employeeId, payScheduleId: scheduleId, country: "CA", province: "ON", payBasis: "salary",
        vacationMethod: "pay_each_period", taxExempt: true, ...fields };
      const invoke = (overrides: Record<string, unknown> = {}) => withOrgContext(org.orgId, () => POST(new Request("http://audit.local/api/payroll/profiles", {
        method: "POST", headers: { "X-Request-Id": "profile-integrity-review" }, body: JSON.stringify({ ...body, ...overrides }),
      })));
      const accepted = ["create audit", "edit audit", "explicit clear", "concurrent create"].includes(label);
      if (label === "audit failure") {
        await assert.rejects(invoke, (error: unknown) => {
          const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
          return String(error).includes("forced payroll profile audit failure") || String(cause).includes("forced payroll profile audit failure");
        });
      } else if (label === "concurrent create") {
        const responses = await Promise.all([invoke({ federalClaimAmount: "100" }), invoke({ federalClaimAmount: "200" })]);
        assert.deepEqual(responses.map(response => response.status), [200, 200]);
      } else {
        const response = await invoke();
        if (accepted) assert.equal(response.status, 200, JSON.stringify(await response.json()));
        else assert.ok(response.status === 400 || response.status === 422, `expected validation refusal, got ${response.status}`);
      }
      const after = (await db.execute(sql`select * from employee_payroll_profiles where employee_party_id=${employeeId}`)).rows[0];
      if (!accepted) assert.deepEqual(after, before);
      const audits = (await db.execute<{ actor_id: string; row_id: string; request_id: string; changes: Record<string, unknown>; action: string }>(sql`
        select actor_id,row_id,request_id,changes,action from audit_log
         where org_id=${org.orgId} and table_name='employee_payroll_profiles'
      `)).rows;
      assert.equal(audits.length, label === "concurrent create" ? 2 : accepted ? 1 : 0);
      if (label === "concurrent create") {
        const created = audits.find(audit => audit.action === "insert");
        const updated = audits.find(audit => audit.action === "update");
        assert.ok(created);
        assert.ok(updated);
        assert.deepEqual(updated.changes.before, created.changes.after, "the second writer audits the first committed profile");
        assert.deepEqual(updated.changes.after, auditSnapshot(after));
      } else if (accepted) {
        const audit = audits[0]!;
        assert.equal(audit.actor_id, actor);
        assert.equal(audit.row_id, after!.id);
        assert.equal(audit.request_id, "profile-integrity-review");
        assert.equal(audit.action, before ? "update" : "insert");
        assert.deepEqual(audit.changes.before, auditSnapshot(before));
        assert.deepEqual(audit.changes.after, auditSnapshot(after));
        const evidence = JSON.stringify(audit);
        assert.ok(!evidence.includes("sin_encrypted"));
        assert.ok(!evidence.includes("123456789"));
        if (before) assert.ok(!evidence.includes(String(before.sin_encrypted)));
        if (label === "explicit clear") assert.equal(after!.sin_encrypted, null);
        else if (before) assert.equal(after!.sin_encrypted, before.sin_encrypted, "omitted SIN stays unchanged");
      }
    } finally {
      if (triggerInstalled) {
        await db.execute(sql.raw(`drop trigger if exists "${trigger}" on audit_log`));
        await db.execute(sql.raw(`drop function if exists public."${trigger}"()`));
      }
      session.user = null;
      await dropScratchOrg(org.orgId);
    }
  });
}
