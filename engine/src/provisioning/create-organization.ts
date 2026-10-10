import { sql } from "drizzle-orm";
import { ensureCloseDefaults } from "../close/defaults.ts";
import { generateAccountingPeriods } from "../close/calendar.ts";
import { isIso4217CurrencyCode } from "../fx/currencies.ts";
import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import { UNUSABLE_PASSWORD_HASH } from "../organization/pending-credential.ts";
import { provisionPayrollPackDefaults } from "../payroll/run-setup.ts";
import { db, withBypass } from "../platform/db.ts";
import { upsertBuiltInRolesForOrg } from "./built-in-role-seed.ts";
import { provisionOrganizationDefaults } from "./organization-provisioning.ts";

/**
 * Organization creation: the one command that brings a new tenant into
 * existence with everything a company needs to operate on day one.
 *
 * Installation bootstrap (the first organization, from environment
 * configuration) and the platform console (every later organization) both
 * compose the steps exported here, so a company created either way starts
 * from the same primary book, close calendar, accounting periods, root legal
 * entity, built-in roles and default configuration.
 */

/** Fiscal years seeded around the current one: two back, five ahead. */
export const INITIAL_FISCAL_YEARS_BACK = 2;
export const INITIAL_FISCAL_YEARS_AHEAD = 5;

const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 320;
const MAX_REASON_LENGTH = 1000;

/**
 * A named refusal from organization creation. Typed with a 4xx status so an
 * API boundary returns its message, code, field and remedy to the operator
 * instead of an opaque server error.
 */
export class OrganizationProvisioningError extends Error {
  readonly status: 400 | 403 | 409;
  readonly code: string;
  readonly field?: string;
  readonly remedy?: string;
  constructor(input: { message: string; status: 400 | 403 | 409; code: string; field?: string; remedy?: string }) {
    super(input.message);
    this.name = "OrganizationProvisioningError";
    this.status = input.status;
    this.code = input.code;
    if (input.field !== undefined) this.field = input.field;
    if (input.remedy !== undefined) this.remedy = input.remedy;
  }
}

export interface OrganizationIdentity {
  name: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string;
  /** ISO 4217 code from the supported currency registry. */
  currency: string;
}

/**
 * Normalize and validate the identity of a new organization. The country is
 * held to the ISO 3166-1 alpha-2 shape here; callers with the full country
 * registry (the platform API) check membership before reaching this point.
 */
export function validateOrganizationIdentity(input: {
  name: unknown;
  country: unknown;
  currency: unknown;
}): OrganizationIdentity {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new OrganizationProvisioningError({
      message: `organization name is required and must be at most ${MAX_NAME_LENGTH} characters`,
      status: 400,
      code: "organization_name_invalid",
      field: "name",
    });
  }
  const country = typeof input.country === "string" ? input.country.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new OrganizationProvisioningError({
      message: "country must be an ISO 3166-1 alpha-2 code",
      status: 400,
      code: "organization_country_invalid",
      field: "country",
      remedy: "Choose the country of the organization's registered head office.",
    });
  }
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!isIso4217CurrencyCode(currency)) {
    throw new OrganizationProvisioningError({
      message: `base currency ${currency || "(blank)"} is not in the supported ISO 4217 registry`,
      status: 400,
      code: "organization_currency_unsupported",
      field: "currency",
      remedy: "Choose a base currency from the supported currency list.",
    });
  }
  return { name, country, currency };
}

/**
 * Insert the organization row. The base currency must already be installed
 * in this database's currency table (installation bootstrap seeds the
 * registry), because every financial record snapshots its functional
 * currency from there.
 */
export async function insertOrganizationRecord(
  identity: OrganizationIdentity,
  actorId: string | null,
): Promise<string> {
  const installed = await db.execute<{ code: string }>(sql`
    select code from currencies where code = ${identity.currency}
  `);
  if (installed.rows.length !== 1) {
    throw new OrganizationProvisioningError({
      message: `base currency ${identity.currency} is not installed in this database`,
      status: 409,
      code: "organization_currency_not_installed",
      field: "currency",
      remedy: "Run the installation bootstrap to seed the currency registry, then retry.",
    });
  }
  const inserted = await db.execute<{ id: string }>(sql`
    insert into orgs (name, base_currency, country, created_by, updated_by)
    values (${identity.name}, ${identity.currency}, ${identity.country}, ${actorId}, ${actorId})
    returning id
  `);
  const orgId = inserted.rows[0]?.id;
  if (inserted.rows.length !== 1 || !orgId) throw new Error("organization insert returned no id");
  return orgId;
}

export interface LedgerFoundation {
  bookId: string;
  calendarId: string;
  firstFiscalYear: number;
  lastFiscalYear: number;
}

/**
 * The primary book, the default close configuration and its fiscal
 * calendar, and the accounting periods from two fiscal years back through
 * five ahead, each generated by the close calendar's own period generator
 * (with open close locks per book). Re-running is safe: existing rows are
 * kept and only missing ones are added.
 */
export async function seedOrganizationLedgerFoundation(
  orgId: string,
  actorId: string | null,
  today: Date = new Date(),
): Promise<LedgerFoundation> {
  await db.execute(sql`
    insert into accounting_books (org_id, code, name, is_primary, created_by, updated_by)
    values (${orgId}, 'primary', 'Primary book', true, ${actorId}, ${actorId})
    -- An existing primary book is the intended end state; the re-read below
    -- fails loudly if the organization still has none.
    on conflict do nothing
  `);
  const book = await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active
  `);
  const bookId = book.rows[0]?.id;
  if (book.rows.length !== 1 || !bookId) {
    throw new Error(`organization ${orgId} must have exactly one active primary book`);
  }

  const { calendarId } = await ensureCloseDefaults(orgId, actorId ?? undefined);

  const thisYear = today.getUTCFullYear();
  const firstFiscalYear = thisYear - INITIAL_FISCAL_YEARS_BACK;
  const lastFiscalYear = thisYear + INITIAL_FISCAL_YEARS_AHEAD;
  for (let year = firstFiscalYear; year <= lastFiscalYear; year++) {
    await generateAccountingPeriods(orgId, calendarId, year, actorId);
  }
  return { bookId, calendarId, firstFiscalYear, lastFiscalYear };
}

/**
 * The root legal entity, mirroring the organization's name, legal name,
 * base currency and country. Every organization has exactly one.
 */
export async function ensureRootSubsidiary(orgId: string, actorId: string | null = null): Promise<string> {
  await db.execute(sql`
    insert into subsidiaries
      (org_id, name, legal_name, base_currency, country, created_at, updated_at, created_by, updated_by)
    select id, name, legal_name, base_currency, country, now(), now(), ${actorId}::uuid, ${actorId}::uuid
      from orgs
     where id = ${orgId}
       and not exists (
         select 1 from subsidiaries where org_id = ${orgId} and parent_id is null
       )
    -- The not-exists guard makes the insert conditional; the conflict arm
    -- only covers a concurrent ensure for the same organization, whose root
    -- is the intended end state. The re-read below fails loudly if no root
    -- exists.
    on conflict do nothing
  `);
  const root = await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null
  `);
  const rootId = root.rows[0]?.id;
  if (root.rows.length !== 1 || !rootId) {
    throw new Error(`organization ${orgId} must have exactly one root subsidiary`);
  }
  return rootId;
}

/**
 * Seed the built-in role catalogue for an organization that has no roles.
 * An organization that already has any role keeps its configuration exactly
 * as administered: the catalogue is a new-organization default, never a
 * reset.
 */
export async function seedBuiltInRolesForNewOrganization(orgId: string): Promise<"seeded" | "preserved"> {
  const existing = await db.execute<{ present: boolean }>(sql`
    select exists(select 1 from app_roles where org_id = ${orgId}) as present
  `);
  const hasRoles = existing.rows[0]?.present;
  if (hasRoles === undefined || hasRoles === null) {
    throw new Error(`could not determine existing roles for organization ${orgId}; refusing to seed blindly`);
  }
  if (hasRoles) return "preserved";
  await upsertBuiltInRolesForOrg(db, orgId, BUILT_IN_ROLES);
  return "seeded";
}

/**
 * Everything an organization needs beyond its row and ledger foundation:
 * the root legal entity, built-in roles, default configuration and the
 * installed payroll packs' defaults.
 */
export async function provisionOrganizationStructure(
  orgId: string,
  actorId: string | null,
): Promise<{ subsidiaryId: string; roles: "seeded" | "preserved" }> {
  const subsidiaryId = await ensureRootSubsidiary(orgId, actorId);
  const roles = await seedBuiltInRolesForNewOrganization(orgId);
  await provisionOrganizationDefaults(orgId, actorId);
  await provisionPayrollPackDefaults(orgId, actorId);
  return { subsidiaryId, roles };
}

export interface CreateOrganizationInput {
  name: string;
  country: string;
  currency: string;
  administrator: { name: string; email: string };
  /** The platform super administrator's home identity. */
  actorId: string;
  /** Why the organization is being created; recorded on every audit row. */
  reason: string;
}

export interface CreatedOrganization {
  orgId: string;
  name: string;
  country: string;
  currency: string;
  bookId: string;
  calendarId: string;
  subsidiaryId: string;
  firstFiscalYear: number;
  lastFiscalYear: number;
  administrator: { userId: string; name: string; email: string; roleId: string };
}

/**
 * Lock an organization's administrator and report whether it is still a
 * pending invitation (active, no password set). Set-password issuance calls
 * this inside its mint transaction, so a link is never minted for an
 * account that was activated, deactivated or moved in the meantime.
 */
export async function lockPendingAdministrator(orgId: string, userId: string): Promise<boolean> {
  const row = (await db.execute<{ is_active: boolean; password_hash: string }>(sql`
    select is_active, password_hash from users where id = ${userId} and org_id = ${orgId} for update
  `)).rows[0];
  return !!row && row.is_active && row.password_hash === UNUSABLE_PASSWORD_HASH;
}

/** Normalize a login address the way sign-in resolves it. */
function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().normalize("NFKC").toLowerCase() : "";
}

/**
 * Create a production organization and its first administrator in one
 * transaction: the organization row, ledger foundation, root legal entity,
 * built-in roles, default configuration, payroll pack defaults, the
 * administrator (with the built-in admin role and no password) and the audit
 * evidence either all commit or none do.
 *
 * The administrator is created as a pending invitation. Access is delivered
 * afterwards through the native set-password link; no password is ever
 * generated, stored or returned here.
 *
 * Retry safety: creation is serialized installation-wide, and a production
 * organization whose name matches case-insensitively is refused with a remedy
 * naming it. A retry after a lost response therefore resolves to that
 * refusal instead of a second organization.
 */
export async function createOrganization(input: CreateOrganizationInput): Promise<CreatedOrganization> {
  const identity = validateOrganizationIdentity(input);
  const adminName = typeof input.administrator?.name === "string" ? input.administrator.name.trim() : "";
  if (!adminName || adminName.length > MAX_NAME_LENGTH) {
    throw new OrganizationProvisioningError({
      message: `administrator name is required and must be at most ${MAX_NAME_LENGTH} characters`,
      status: 400,
      code: "administrator_name_invalid",
      field: "adminName",
    });
  }
  const adminEmail = normalizeEmail(input.administrator?.email);
  if (!adminEmail || adminEmail.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(adminEmail)) {
    throw new OrganizationProvisioningError({
      message: "administrator email must be a valid address",
      status: 400,
      code: "administrator_email_invalid",
      field: "adminEmail",
    });
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > MAX_REASON_LENGTH) {
    throw new OrganizationProvisioningError({
      message: `a reason is required and must be at most ${MAX_REASON_LENGTH} characters`,
      status: 400,
      code: "reason_required",
      field: "reason",
    });
  }

  // bypass: cross-org-by-design — creating an organization checks names and login identities across every organization and writes a tenant whose id does not exist until this transaction mints it.
  return withBypass(async () => {
    // One creation at a time, so the name and login-identity checks below
    // cannot both pass for two concurrent requests.
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended('openbooks:organization-create', 0))`);

    const actor = (await db.execute<{ id: string; is_active: boolean; is_super_admin: boolean }>(sql`
      select id, is_active, is_super_admin from users where id = ${input.actorId} for update
    `)).rows[0];
    if (!actor || !actor.is_active || !actor.is_super_admin) {
      throw new OrganizationProvisioningError({
        message: "only an active platform super administrator can create an organization",
        status: 403,
        code: "platform_authority_required",
        remedy: "Sign in again as an active platform super administrator, then retry.",
      });
    }

    const sameName = (await db.execute<{ id: string; name: string }>(sql`
      select id, name from orgs
       where env_kind = 'production' and lower(btrim(name)) = lower(${identity.name})
       order by created_at limit 1
    `)).rows[0];
    if (sameName) {
      throw new OrganizationProvisioningError({
        message: `an organization named "${sameName.name}" already exists`,
        status: 409,
        code: "organization_name_taken",
        field: "name",
        remedy:
          "Choose a different name. If this repeats a creation that already succeeded, open that organization from Platform → Organizations; " +
          "its pending administrator's set-password link can be re-issued from Admin → Users.",
      });
    }

    // A login address resolves to exactly one active home identity across
    // production organizations; a second one would lock both people out.
    const identityTaken = (await db.execute<{ id: string }>(sql`
      select u.id from users u
        join orgs o on o.id = u.org_id and o.env_kind = 'production'
       where lower(u.email) = ${adminEmail} and u.is_active
       limit 1
    `)).rows[0];
    if (identityTaken) {
      throw new OrganizationProvisioningError({
        message: `${adminEmail} already signs in to another organization`,
        status: 409,
        code: "administrator_email_in_use",
        field: "adminEmail",
        remedy:
          "Use a different address for the first administrator. To give this person access to the new organization as well, " +
          "grant cross-organization access from Platform → Access once it exists.",
      });
    }

    const orgId = await insertOrganizationRecord(identity, actor.id);
    const foundation = await seedOrganizationLedgerFoundation(orgId, actor.id);
    const structure = await provisionOrganizationStructure(orgId, actor.id);
    if (structure.roles !== "seeded") {
      throw new Error(`new organization ${orgId} already held roles before the built-in catalogue was seeded`);
    }

    const user = (await db.execute<{ id: string }>(sql`
      insert into users (org_id, email, name, password_hash, is_active, created_by, updated_by)
      values (${orgId}, ${adminEmail}, ${adminName}, ${UNUSABLE_PASSWORD_HASH}, true, ${actor.id}, ${actor.id})
      returning id
    `)).rows;
    const userId = user[0]?.id;
    if (user.length !== 1 || !userId) throw new Error("administrator insert returned no id");

    const assignment = (await db.execute<{ id: string; role_id: string }>(sql`
      insert into role_assignments (org_id, user_id, role_id, created_by, updated_by)
      select ${orgId}::uuid, ${userId}::uuid, id, ${actor.id}::uuid, ${actor.id}::uuid
        from app_roles
       where org_id = ${orgId} and key = 'admin' and is_built_in
      returning id, role_id
    `)).rows;
    const assignmentRow = assignment[0];
    if (assignment.length !== 1 || !assignmentRow) {
      throw new Error("the first administrator did not receive exactly one built-in admin role assignment");
    }

    const audit = async (table: string, rowId: string, after: Record<string, unknown>) => {
      const written = await db.execute<{ id: string }>(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, ${table}, ${rowId}, 'insert', ${JSON.stringify({
          source: "platform_admin",
          reason,
          before: null,
          after,
        })}::jsonb, ${actor.id})
        returning id
      `);
      if (written.rows.length !== 1) throw new Error(`audit evidence for ${table} ${rowId} was not written`);
    };
    await audit("orgs", orgId, {
      name: identity.name,
      country: identity.country,
      base_currency: identity.currency,
      env_kind: "production",
      primary_book_id: foundation.bookId,
      fiscal_calendar_id: foundation.calendarId,
      root_subsidiary_id: structure.subsidiaryId,
      fiscal_years: [foundation.firstFiscalYear, foundation.lastFiscalYear],
      built_in_roles: Object.keys(BUILT_IN_ROLES).length,
    });
    await audit("users", userId, {
      email: adminEmail,
      name: adminName,
      is_active: true,
      password: "pending_invitation",
    });
    await audit("role_assignments", assignmentRow.id, {
      user_id: userId,
      role_id: assignmentRow.role_id,
      role_key: "admin",
    });

    return {
      orgId,
      name: identity.name,
      country: identity.country,
      currency: identity.currency,
      bookId: foundation.bookId,
      calendarId: foundation.calendarId,
      subsidiaryId: structure.subsidiaryId,
      firstFiscalYear: foundation.firstFiscalYear,
      lastFiscalYear: foundation.lastFiscalYear,
      administrator: { userId, name: adminName, email: adminEmail, roleId: assignmentRow.role_id },
    };
  });
}
