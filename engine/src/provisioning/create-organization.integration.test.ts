import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db } from "../platform/db.ts";
import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import { UNUSABLE_PASSWORD_HASH } from "../organization/pending-credential.ts";
import { CLOSE_MODULES } from "../periods/period-policy.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  createOrganization,
  INITIAL_FISCAL_YEARS_AHEAD,
  INITIAL_FISCAL_YEARS_BACK,
  OrganizationProvisioningError,
} from "./create-organization.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Organization creation from the platform console: one transaction yields
 * a complete, isolated tenant with a pending first administrator and audit
 * evidence, and every refusal leaves nothing behind.
 */

type Platform = { homeOrgId: string; superAdminId: string; superAdminEmail: string; memberId: string };

async function platform(): Promise<Platform> {
  const home = await createScratchOrg();
  const superAdminId = await createScratchUser(home.orgId, "Platform operator", "admin");
  const memberId = await createScratchUser(home.orgId, "Ordinary member", "admin");
  const promoted = await db.execute<{ email: string }>(sql`
    update users set is_super_admin = true where id = ${superAdminId} returning email`);
  assert.equal(promoted.rows.length, 1);
  return { homeOrgId: home.orgId, superAdminId, superAdminEmail: promoted.rows[0]!.email, memberId };
}

function spec(actorId: string, overrides: Partial<Parameters<typeof createOrganization>[0]> = {}) {
  const tag = randomUUID().slice(0, 8);
  return {
    name: `Scratch Created ${tag}`,
    country: "ca",
    currency: "cad",
    administrator: { name: "First Administrator", email: ` First.Admin.${tag}@Scratch.Test ` },
    actorId,
    reason: "Onboarding a new customer company",
    ...overrides,
  };
}

async function orgsNamed(name: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`select count(*)::int as n from orgs where name = ${name}`)).rows[0]!.n;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  return (await db.execute<{ n: number }>(query)).rows[0]!.n;
}

async function refusal(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof OrganizationProvisioningError, `expected a typed refusal, got ${String(error)}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}

test("a created organization is complete, isolated, audited and its administrator is a pending invitation", { skip: !DB }, async () => {
  const p = await platform();
  const input = spec(p.superAdminId);
  let orgId: string | undefined;
  try {
    const homeUsersBefore = await count(sql`select count(*)::int as n from users where org_id = ${p.homeOrgId}`);
    const homeAuditBefore = await count(sql`select count(*)::int as n from audit_log where org_id = ${p.homeOrgId}`);

    const created = await createOrganization(input);
    orgId = created.orgId;

    const org = (await db.execute<{ name: string; country: string; base_currency: string; env_kind: string; created_by: string }>(sql`
      select name, country, base_currency, env_kind, created_by from orgs where id = ${orgId}`)).rows;
    assert.deepEqual(org, [{
      name: input.name, country: "CA", base_currency: "CAD", env_kind: "production", created_by: p.superAdminId,
    }]);

    // Ledger foundation: one primary book, the default close calendar and
    // monthly periods two fiscal years back through five ahead, each with an
    // open close lock per module.
    const books = (await db.execute<{ id: string }>(sql`
      select id from accounting_books where org_id = ${orgId} and is_primary and is_active`)).rows;
    assert.deepEqual(books.map((row) => row.id), [created.bookId]);
    const calendars = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${orgId} and is_default and is_active`)).rows;
    assert.deepEqual(calendars.map((row) => row.id), [created.calendarId]);
    const thisYear = new Date().getUTCFullYear();
    assert.equal(created.firstFiscalYear, thisYear - INITIAL_FISCAL_YEARS_BACK);
    assert.equal(created.lastFiscalYear, thisYear + INITIAL_FISCAL_YEARS_AHEAD);
    const years = INITIAL_FISCAL_YEARS_BACK + INITIAL_FISCAL_YEARS_AHEAD + 1;
    const periods = (await db.execute<{ n: number; first: number; last: number }>(sql`
      select count(*)::int as n, min(fiscal_year)::int as first, max(fiscal_year)::int as last
        from accounting_periods
       where org_id = ${orgId} and fiscal_calendar_id = ${created.calendarId} and not is_adjustment`)).rows[0]!;
    assert.deepEqual(periods, { n: years * 12, first: created.firstFiscalYear, last: created.lastFiscalYear });
    assert.equal(
      await count(sql`select count(*)::int as n from period_locks where org_id = ${orgId} and book_id = ${created.bookId} and state = 'open'`),
      years * 12 * CLOSE_MODULES.length,
    );

    // Root legal entity mirrors the organization.
    const roots = (await db.execute<{ id: string; base_currency: string; country: string }>(sql`
      select id, base_currency, country from subsidiaries where org_id = ${orgId} and parent_id is null`)).rows;
    assert.deepEqual(roots, [{ id: created.subsidiaryId, base_currency: "CAD", country: "CA" }]);

    // Built-in roles carry the current catalogue grants.
    const roles = (await db.execute<{ key: string; permissions: string[] }>(sql`
      select key, permissions from app_roles where org_id = ${orgId} and is_built_in order by key`)).rows;
    assert.deepEqual(roles.map((row) => row.key), Object.keys(BUILT_IN_ROLES).sort());
    for (const role of roles) assert.deepEqual(role.permissions, BUILT_IN_ROLES[role.key]!.permissions, role.key);

    // Organization defaults: project types, payment formats and forms.
    assert.equal(
      await count(sql`select count(*)::int as n from project_types where org_id = ${orgId} and is_built_in`),
      BUILTIN_PROJECT_TYPES.length,
    );
    assert.ok(await count(sql`select count(*)::int as n from payment_formats where org_id = ${orgId}`) > 0);
    assert.ok(await count(sql`select count(*)::int as n from form_layouts where org_id = ${orgId} and is_default`) > 0);
    // No payroll pack is installed on a new organization, so pack defaults
    // have nothing to apply until an administrator installs one.
    const payrollCountries = (await db.execute<{ countries: unknown }>(sql`
      select settings#>'{payroll,countries}' as countries from orgs where id = ${orgId}`)).rows[0]!.countries;
    assert.equal(payrollCountries, null);

    // The first administrator: normalized address, no usable password, and
    // exactly the built-in admin role.
    const users = (await db.execute<{ id: string; email: string; name: string; password_hash: string; is_active: boolean; is_super_admin: boolean }>(sql`
      select id, email, name, password_hash, is_active, is_super_admin from users where org_id = ${orgId}`)).rows;
    assert.equal(users.length, 1);
    const admin = users[0]!;
    assert.equal(admin.id, created.administrator.userId);
    assert.equal(admin.email, input.administrator.email.trim().toLowerCase());
    assert.equal(admin.name, "First Administrator");
    assert.equal(admin.password_hash, UNUSABLE_PASSWORD_HASH);
    assert.equal(admin.is_active, true);
    assert.equal(admin.is_super_admin, false);
    const assignments = (await db.execute<{ key: string; is_built_in: boolean }>(sql`
      select r.key, r.is_built_in from role_assignments a join app_roles r on r.id = a.role_id
       where a.org_id = ${orgId} and a.user_id = ${admin.id}`)).rows;
    assert.deepEqual(assignments, [{ key: "admin", is_built_in: true }]);

    // Audit evidence: the operator, the reason and the after-state for the
    // organization, the administrator and the role assignment.
    const audit = (await db.execute<{ table_name: string; row_id: string; action: string; actor_id: string; changes: { reason: string; before: unknown; after: Record<string, unknown> } }>(sql`
      select table_name, row_id, action, actor_id, changes from audit_log where org_id = ${orgId} and changes->>'source' = 'platform_admin'
       order by table_name`)).rows;
    assert.deepEqual(audit.map((row) => row.table_name), ["orgs", "role_assignments", "users"]);
    for (const row of audit) {
      assert.equal(row.action, "insert");
      assert.equal(row.actor_id, p.superAdminId);
      assert.equal(row.changes.reason, input.reason);
      assert.equal(row.changes.before, null);
    }
    assert.equal(audit[0]!.row_id, orgId);
    assert.equal(audit[0]!.changes.after.base_currency, "CAD");
    assert.equal(audit[2]!.row_id, admin.id);
    assert.equal(audit[2]!.changes.after.password, "pending_invitation");

    // Isolation: the operator's home organization gained nothing.
    assert.equal(await count(sql`select count(*)::int as n from users where org_id = ${p.homeOrgId}`), homeUsersBefore);
    assert.equal(await count(sql`select count(*)::int as n from audit_log where org_id = ${p.homeOrgId}`), homeAuditBefore);
    assert.equal(
      await count(sql`select count(*)::int as n from role_assignments where user_id = ${admin.id} and org_id <> ${orgId}`),
      0,
    );

    // A retry of the same creation is refused by name and creates nothing.
    await refusal(createOrganization({ ...input, name: input.name.toUpperCase() }), "organization_name_taken", 409);
    assert.equal(await orgsNamed(input.name), 1);
  } finally {
    if (orgId) await dropScratchOrgReporting(orgId);
    await dropScratchOrgReporting(p.homeOrgId);
  }
});

test("refusals name the field and leave no organization behind", { skip: !DB }, async () => {
  const p = await platform();
  try {
    const badCountry = spec(p.superAdminId, { country: "C1" });
    await refusal(createOrganization(badCountry), "organization_country_invalid", 400);
    assert.equal(await orgsNamed(badCountry.name), 0);

    const badCurrency = spec(p.superAdminId, { currency: "ZZZ" });
    await refusal(createOrganization(badCurrency), "organization_currency_unsupported", 400);
    assert.equal(await orgsNamed(badCurrency.name), 0);

    const noReason = spec(p.superAdminId, { reason: "   " });
    await refusal(createOrganization(noReason), "reason_required", 400);
    assert.equal(await orgsNamed(noReason.name), 0);

    // Platform authority is enforced by the command itself, not only the API.
    const notPlatform = spec(p.memberId);
    await refusal(createOrganization(notPlatform), "platform_authority_required", 403);
    assert.equal(await orgsNamed(notPlatform.name), 0);

    const revoked = await db.execute(sql`update users set is_active = false where id = ${p.memberId} returning id`);
    assert.equal(revoked.rows.length, 1);
    await db.execute(sql`update users set is_super_admin = true where id = ${p.memberId}`);
    await refusal(createOrganization(spec(p.memberId)), "platform_authority_required", 403);

    // An address that already signs in elsewhere would leave two active home
    // identities for one login, so it is refused before anything is written.
    const takenEmail = spec(p.superAdminId, { administrator: { name: "Duplicate", email: p.superAdminEmail.toUpperCase() } });
    await refusal(createOrganization(takenEmail), "administrator_email_in_use", 409);
    assert.equal(await orgsNamed(takenEmail.name), 0);
  } finally {
    await dropScratchOrgReporting(p.homeOrgId);
  }
});
