import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import { explainPay } from "./explain-pay.ts";
import { AiRailsError } from "./errors.ts";

/**
 * H-EXPLAINPAY regression: the elevated explain-pay paths returned pay
 * data on the grant alone. assertExplainScope returned immediately for
 * payroll.manage or hrm.employment.read holders with no employer check,
 * so an A-scoped actor naming a B employmentId received B's pay
 * components, inputs, net pay, and the prior-stub difference.
 *
 * Elevated paths now gate on the employment's employer subsidiary
 * (payroll.manage through the trusted employment row; hrm.employment.read
 * through the canonical employment gate). Unknown, cross-org, and
 * out-of-scope employments refuse identically as ai_subject_missing —
 * this endpoint's not-found — while an in-scope employment with no stub
 * yet reaches ai_no_payslip, proving the refusal for B is the scope gate
 * and not a missing payslip. The HRM authorization error has no mapping
 * in aiRailsErrorResponse, so it is converted, never leaked as a 500.
 * The self path (own employment only) is unchanged. No stubs are seeded:
 * the differential between the two refusal codes IS the behavioral
 * proof, read back through the service.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableExplainPay(orgId: string): Promise<void> {
  for (const key of ["hrm", "payroll", "hrmAiAssist", "hrmExplainPay"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${key}}`}, 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function grant(orgId: string, userId: string, permission: string): Promise<void> {
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${orgId}, ${userId}, ${permission}, 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'`);
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function seedEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const party = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${party}, ${orgId}, 'person', 'Explain Worker', true, '{}'::jsonb)`);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${party}, ${subsidiaryId}, 1)`);
  return employmentId;
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AiRailsError, `expected AiRailsError, got ${(e as Error)?.constructor?.name}`);
    return { code: e.code, message: e.message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("H-EXPLAINPAY: elevated grants do not open another entity's pay", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableExplainPay(org.orgId);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedEmployment(org.orgId, org.subsidiaryId);
    const empB = await seedEmployment(org.orgId, subB);
    const fabricated = randomUUID();

    const payrollA = await createScratchUser(org.orgId, "Payroll A", "explain_payroll_a");
    await scopeRole(org.orgId, "explain_payroll_a", ["payroll.manage"], [org.subsidiaryId]);
    const hrA = await createScratchUser(org.orgId, "HR A", "explain_hr_a");
    await scopeRole(org.orgId, "explain_hr_a", ["hrm.employment.read"], [org.subsidiaryId]);

    for (const [name, actorId] of [["payroll.manage", payrollA], ["hrm.employment.read", hrA]] as const) {
      // B's employment refuses exactly like a fabricated id: the scoped
      // holder learns neither existence nor pay coverage.
      const hidden = await refusalOf(explainPay(db, { orgId: org.orgId, actorId, employmentId: empB }));
      const unknown = await refusalOf(explainPay(db, { orgId: org.orgId, actorId, employmentId: fabricated }));
      assert.deepEqual(hidden, unknown, `${name}: B must refuse identically to unknown`);
      assert.equal(hidden.code, "ai_subject_missing");
      // The in-scope employment passes the gate and reaches the stub
      // lookup instead — no payslip exists, which is a different code.
      // That differential proves the B refusal is the scope gate firing.
      const inScope = await refusalOf(explainPay(db, { orgId: org.orgId, actorId, employmentId: empA }));
      assert.equal(inScope.code, "ai_no_payslip", `${name}: in-scope employment must pass scope`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-EXPLAINPAY: unrestricted HR reads keep working without a stub", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableExplainPay(org.orgId);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empB = await seedEmployment(org.orgId, subB);
    const hrFull = await createScratchUser(org.orgId, "HR Full", "explain_hr_full");
    await grant(org.orgId, hrFull, "hrm.employment.read");
    // Unrestricted scope passes the gate; the missing stub is the refusal.
    const missing = await refusalOf(
      explainPay(db, { orgId: org.orgId, actorId: hrFull, employmentId: empB }),
    );
    assert.equal(missing.code, "ai_no_payslip");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
