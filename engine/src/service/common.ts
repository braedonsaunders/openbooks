/**
 * Shared service dispatch plumbing: feature and permission authority, the
 * technician's self scope, input validation, numbering and audit.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { grantsConferring } from "../organization/permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { ServiceError } from "./errors.ts";
import { SERVICE_PRIORITIES, type ServicePriority } from "./status.ts";

export interface ServiceActor {
  readonly orgId: string;
  readonly actorId: string;
}

export type ServicePermission = "service.read" | "service.manage" | "service.dispatch";

/** The engine acting for an organization (agreement generation); never a user row. */
export const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** The user an audit or history row names: null for the engine's own work. */
export function actorRef(actor: ServiceActor): string | null {
  return actor.actorId === SYSTEM_ACTOR ? null : actor.actorId;
}

/** The switches service dispatch needs, parent first. */
export const SERVICE_FEATURES = ["hrm", "hrmShiftPlanning", "serviceDispatch"] as const;

/** Refuse while Service dispatch (or its Scheduling parent) is off; holds the feature fence to commit. */
export async function lockServiceFeature(orgId: string): Promise<void> {
  for (const feature of SERVICE_FEATURES) {
    if (!(await lockAndCheckOrgFeature(db, orgId, feature))) {
      throw new ServiceError("Service dispatch is switched off for this organization.", {
        status: 404,
        code: "service_disabled",
        remedy:
          "Enable Human Resources, Scheduling and Service dispatch on Company Settings → Features; existing service records are preserved.",
      });
    }
  }
}

/** Require a dependent feature (Orders, Inventory, Time tracking) for one capability. */
export async function lockDependentFeature(
  orgId: string,
  feature: string,
  label: string,
): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, feature))) {
    throw new ServiceError(`${label} is switched off for this organization.`, {
      status: 404,
      code: "service_dependency_disabled",
      remedy: `Enable ${label} on Company Settings → Features to use it on service work.`,
    });
  }
}

/**
 * Lock the caller's service authority in a subsidiary. Reading accepts any
 * grant that confers service reads over everyone's records (read, manage,
 * dispatch). Returns the caller's visible subsidiaries (null: unrestricted).
 */
export async function serviceAuthority(
  actor: ServiceActor,
  permission: ServicePermission,
  subsidiaryId: string | null,
): Promise<ReadonlySet<string> | null> {
  await lockServiceFeature(actor.orgId);
  const candidates =
    permission === "service.read" ? grantsConferring("service.read", "all") : [permission];
  for (const candidate of candidates) {
    if (await actorHasPermission(db, actor.orgId, actor.actorId, candidate)) {
      return lockActorCommandAuthority(db, actor.orgId, actor.actorId, subsidiaryId, candidate);
    }
  }
  throw new ScopeNotFoundError();
}

/** Whether the caller holds a service grant, without locking (for read-model affordances). */
export async function holdsServicePermission(
  actor: ServiceActor,
  permission: ServicePermission | "service.self",
): Promise<boolean> {
  return actorHasPermission(db, actor.orgId, actor.actorId, permission);
}

/**
 * The technician behind the login, for self-service on their own visits.
 * Needs Service dispatch, the self grant and a login linked to a person.
 */
export async function technicianParty(actor: ServiceActor): Promise<string> {
  await lockServiceFeature(actor.orgId);
  await lockActorCommandAuthority(db, actor.orgId, actor.actorId, null, "service.self");
  const row = (
    await db.execute<{ partyId: string | null }>(
      sql`select party_id as "partyId" from users
    where org_id = ${actor.orgId} and id = ${actor.actorId} and is_active for share`,
      "objects",
    )
  )[0];
  if (!row?.partyId) {
    throw new ServiceError(
      "Your login is not linked to a person, so there are no visits to show.",
      {
        code: "service_no_person",
        remedy: "Ask an administrator to link your user to your employee record.",
      },
    );
  }
  return row.partyId;
}

export function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value))
    throw new ServiceError(`${field} is not recognized.`, {
      code: "service_invalid",
      remedy: `Choose the ${field.toLowerCase()} again.`,
    });
  return value;
}

export function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireUuid(value, field);
}

export function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new ServiceError(`${field} is required.`, {
      code: "service_invalid",
      remedy: `Enter the ${field.toLowerCase()}.`,
    });
  const trimmed = value.trim();
  if (trimmed.length > maximum)
    throw new ServiceError(`${field} is limited to ${maximum} characters.`, {
      code: "service_invalid",
      remedy: `Shorten the ${field.toLowerCase()}.`,
    });
  return trimmed;
}

export function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new ServiceError(`${field} must be text.`, { code: "service_invalid" });
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maximum)
    throw new ServiceError(`${field} is limited to ${maximum} characters.`, {
      code: "service_invalid",
      remedy: `Shorten the ${field.toLowerCase()}.`,
    });
  return trimmed;
}

export function requireDate(value: unknown, field: string): string {
  if (!isIsoCalendarDate(value))
    throw new ServiceError(`${field} needs a real calendar date.`, {
      code: "service_invalid_date",
      remedy: `Choose the ${field.toLowerCase()} again.`,
    });
  return value;
}

export function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireDate(value, field);
}

export function requireInstant(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ServiceError(`${field} needs a date and time.`, {
      code: "service_invalid_time",
      remedy: `Choose the ${field.toLowerCase()} again.`,
    });
  }
  return new Date(Date.parse(value)).toISOString();
}

export function optionalInstant(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requireInstant(value, field);
}

export function requirePriority(value: unknown): ServicePriority {
  if (typeof value !== "string" || !(SERVICE_PRIORITIES as readonly string[]).includes(value)) {
    throw new ServiceError("Choose a priority: low, normal, high or urgent.", {
      code: "service_invalid",
    });
  }
  return value as ServicePriority;
}

export function requireMinutes(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 5 || value > 1440) {
    throw new ServiceError(`${field} must be a whole number of minutes from 5 to 1440.`, {
      code: "service_invalid",
    });
  }
  return value;
}

/** An exact positive quantity (up to eight decimal places). */
export function requireQuantity(value: unknown, field: string): string {
  const canonical = canonicalDecimal(value, 8);
  if (canonical === null || compareDecimal(canonical, "0") <= 0) {
    throw new ServiceError(`${field} must be a positive exact number.`, {
      code: "service_invalid",
      remedy: `Enter the ${field.toLowerCase()} with at most eight decimal places.`,
    });
  }
  return canonical;
}

/** An exact non-negative unit price (up to eight decimal places). */
export function requireUnitPrice(value: unknown, field: string): string {
  const canonical = canonicalDecimal(value, 8);
  if (canonical === null || compareDecimal(canonical, "0") < 0) {
    throw new ServiceError(`${field} must be an exact amount of zero or more.`, {
      code: "service_invalid",
      remedy: `Enter the ${field.toLowerCase()} with at most eight decimal places.`,
    });
  }
  return canonical;
}

/** An exact non-negative money amount (four decimal places). */
export function requireMoney(value: unknown, field: string): string {
  const canonical = canonicalDecimal(value, 4);
  if (canonical === null || compareDecimal(canonical, "0") < 0) {
    throw new ServiceError(`${field} must be an exact amount of zero or more.`, {
      code: "service_invalid",
      remedy: `Enter the ${field.toLowerCase()} with at most four decimal places.`,
    });
  }
  return canonical;
}

export function requireExpectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ServiceError("The record's revision is required.", {
      status: 409,
      code: "service_stale",
      remedy: "Reload the record and make the change again.",
    });
  }
  return value as number;
}

export function requireUuidList(value: unknown, field: string, maximum = 100): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum)
    throw new ServiceError(`${field} is not valid.`, { code: "service_invalid" });
  const out = new Set<string>();
  for (const entry of value) out.add(requireUuid(entry, field));
  return [...out];
}

/** Lock the advisory key that serializes one command's idempotency key. */
export async function lockCommandKey(scope: string, orgId: string, key: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${scope}:${orgId}:${key}`}, 0))`,
  );
}

const NUMBER_PREFIXES = {
  service_request: "SR-",
  service_job: "SJ-",
  service_agreement: "SA-",
} as const;

/** The next number of a service record kind from the organization's sequences. */
export function allocateServiceNumber(
  orgId: string,
  kind: keyof typeof NUMBER_PREFIXES,
): Promise<string> {
  return allocateDocumentNumber(db, orgId, kind, NUMBER_PREFIXES[kind]);
}

/** Record one material change with its actor, before and after state and reason. */
export async function auditService(input: {
  orgId: string;
  table: string;
  rowId: string;
  action: "insert" | "update";
  actorId: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}): Promise<void> {
  const changes = {
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason ?? null,
  };
  const rows = await db.execute<{ id: string }>(
    sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, ${input.table}, ${input.rowId}, ${input.action}, ${JSON.stringify(changes)}::jsonb, ${input.actorId}) returning id`,
    "objects",
  );
  if (rows.length !== 1)
    throw new ServiceError("The change could not be audited.", {
      code: "service_not_saved",
      remedy: "Try again; nothing was saved.",
    });
}

/** Require exactly one affected row for a required write. */
export function requireOne<T>(rows: readonly T[], what: string): T {
  if (rows.length !== 1)
    throw new ServiceError(`${what} was not saved.`, {
      status: 409,
      code: "service_not_saved",
      remedy: "Reload and try again.",
    });
  return rows[0]!;
}

export interface ServiceCustomer {
  readonly customerPartyId: string;
  readonly customerName: string;
  readonly subsidiaryId: string;
  readonly serviceAddressId: string | null;
  readonly contactId: string | null;
}

/**
 * Validate the customer, service location and site contact of a service
 * record: an active customer visible to the caller, an address and contact
 * that belong to that customer, and the legal entity the work is done for.
 */
export async function resolveServiceCustomer(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  input: {
    customerPartyId: unknown;
    serviceAddressId?: unknown;
    contactId?: unknown;
    subsidiaryId?: unknown;
  },
): Promise<ServiceCustomer> {
  const customerPartyId = requireUuid(input.customerPartyId, "Customer");
  const party = (
    await db.execute<{ name: string; subsidiaryId: string | null }>(
      sql`select p.display_name as name, p.subsidiary_id as "subsidiaryId"
    from parties p join customer_roles c on c.org_id = p.org_id and c.party_id = p.id
    where p.org_id = ${orgId} and p.id = ${customerPartyId} and p.is_active and c.is_active for share of p`,
      "objects",
    )
  )[0];
  if (!party)
    throw new ServiceError("This customer is not available.", {
      code: "service_customer_unavailable",
      remedy: "Choose an active customer you have access to.",
    });
  const requested = optionalUuid(input.subsidiaryId, "Legal entity");
  let subsidiaryId = requested ?? party.subsidiaryId;
  if (!subsidiaryId) {
    const root = (
      await db.execute<{ id: string }>(
        sql`select id from subsidiaries where org_id = ${orgId} and parent_id is null`,
        "objects",
      )
    )[0];
    if (!root)
      throw new ServiceError("The organization has no root legal entity.", {
        code: "service_configuration_missing",
        remedy: "Set up the organization's legal entity in Company Settings.",
      });
    subsidiaryId = root.id;
  }
  if (party.subsidiaryId && requested && party.subsidiaryId !== requested) {
    throw new ServiceError("The customer belongs to another legal entity.", {
      code: "service_invalid",
      remedy: "Choose the customer's legal entity or another customer.",
    });
  }
  if (allowed !== null && !allowed.has(subsidiaryId)) throw new ScopeNotFoundError();
  const active = (
    await db.execute(
      sql`select 1 from subsidiaries where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination`,
      "objects",
    )
  )[0];
  if (!active)
    throw new ServiceError("The legal entity is not available.", {
      code: "service_invalid",
      remedy: "Choose an active legal entity.",
    });
  const serviceAddressId = optionalUuid(input.serviceAddressId, "Service location");
  if (serviceAddressId) {
    const address = (
      await db.execute(
        sql`select 1 from addresses where org_id = ${orgId} and id = ${serviceAddressId} and party_id = ${customerPartyId}`,
        "objects",
      )
    )[0];
    if (!address)
      throw new ServiceError("The service location is not one of this customer's addresses.", {
        code: "service_invalid",
        remedy: "Choose an address on the customer record or add one there first.",
      });
  }
  const contactId = optionalUuid(input.contactId, "Site contact");
  if (contactId) {
    const contact = (
      await db.execute(
        sql`select 1 from contacts where org_id = ${orgId} and id = ${contactId} and party_id = ${customerPartyId} and is_active`,
        "objects",
      )
    )[0];
    if (!contact)
      throw new ServiceError("The site contact is not an active contact of this customer.", {
        code: "service_invalid",
        remedy: "Choose a contact on the customer record or add one there first.",
      });
  }
  return { customerPartyId, customerName: party.name, subsidiaryId, serviceAddressId, contactId };
}

/** Validate qualification types required by a visit or job: active native types of this organization. */
export async function requireQualificationTypes(orgId: string, value: unknown): Promise<string[]> {
  const ids = requireUuidList(value, "Required qualification");
  if (!ids.length) return ids;
  const found = await db.execute<{ id: string }>(
    sql`select id from hrm_qualification_types
    where org_id = ${orgId} and is_active and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    "objects",
  );
  if (found.length !== ids.length) {
    throw new ServiceError("A required qualification is not an active qualification type.", {
      code: "service_invalid",
      remedy: "Choose active qualification types from Setup → Qualification types.",
    });
  }
  return ids;
}

/** Validate an item a service line or part names: an active item of this organization. */
export async function requireActiveItem(
  orgId: string,
  itemId: unknown,
  field = "Item",
): Promise<{ id: string; name: string; kind: string; inventoryProfiled: boolean }> {
  const id = requireUuid(itemId, field);
  const row = (
    await db.execute<{ id: string; name: string; kind: string; inventoryProfiled: boolean }>(
      sql`select i.id, coalesce(nullif(i.code, '') || ' — ', '') || i.name as name, i.kind,
      exists (select 1 from item_inventory_profiles p where p.org_id = i.org_id and p.item_id = i.id) as "inventoryProfiled"
    from items i where i.org_id = ${orgId} and i.id = ${id} and i.is_active`,
      "objects",
    )
  )[0];
  if (!row)
    throw new ServiceError(`${field} is not an active item.`, {
      code: "service_invalid",
      remedy: "Choose an active item from the item list.",
    });
  return row;
}

/** Validate a tax code a line names. */
export async function optionalTaxCode(orgId: string, value: unknown): Promise<string | null> {
  const id = optionalUuid(value, "Tax code");
  if (!id) return null;
  const row = (
    await db.execute(
      sql`select 1 from tax_codes where org_id = ${orgId} and id = ${id} and is_active`,
      "objects",
    )
  )[0];
  if (!row)
    throw new ServiceError("The tax code is not active.", {
      code: "service_invalid",
      remedy: "Choose an active tax code.",
    });
  return id;
}
