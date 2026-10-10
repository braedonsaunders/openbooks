import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { normalizeMoney } from "../money/money.ts";
import { moneyRefusal } from "../money/decimal-refusal.ts";
import { normalizeSubdivisionCode } from "../compliance/lien-jurisdictions.ts";
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from "../records/custom-fields.ts";
import { resolveIdempotentReplay } from "../records/idempotent-replay.ts";
import { acquireOrgFeatureGateLock } from "../organization/org-feature-lock.ts";
import { isFeatureEnabled } from "../organization/feature-state.ts";
import { subsidiaryScopeAllows, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { pinInternalPerson } from "../organization/internal-person.ts";
import { checkPinnedOperatingProfileCommand, resolveOperatingProfileForCreate } from "../organization/operating-profiles.ts";

/**
 * Project creation — the one write path for new projects.
 *
 * The caller supplies a UUID key that becomes the project id. Retrying the
 * same request therefore returns the same project without a duplicate insert
 * or duplicate audit event; a reused key with a changed payload is a 409,
 * never the older project returned as though it matched.
 *
 * The write runs under the org's feature-gate fence with the `projects` gate
 * re-checked inside the same transaction: a concurrent feature disable could
 * otherwise commit between an entry check and this write and strand an
 * active project under a disabled feature. The fence is the one the disable
 * path holds while it re-evaluates its blockers, so exactly one side wins.
 *
 * The API route and quote award both create through here, so every
 * reference, scope and custom-field rule applies to both.
 */

export const PROJECT_STATUSES = ["quoted", "awarded", "active", "substantially_complete", "closed", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** The request-controlled create fields, as received at the API boundary. */
export interface ProjectCreateRequest {
  name: string;
  isActive?: boolean;
  /** Internal (shop/overhead) time target: customer-less, non-billable, and
   * excluded from labor cost posting. Once time is booked the flag locks. */
  isInternal?: boolean;
  subsidiaryIncludeChildren?: boolean;
  status?: string;
  customerId?: string | null;
  foremanId?: string | null;
  managerId?: string | null;
  subsidiaryId?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  invoicingPreference?: Record<string, unknown> | null;
  custom?: Record<string, unknown>;
  contractValue?: string | null;
  siteJurisdiction?: string | null;
  projectTypeId?: string | null;
  code?: string | null;
  customerPoNumber?: string | null;
  notes?: string | null;
  operatingProfile?: string | null;
  operatingDepartmentId?: string | null;
}

export interface ProjectCreateContext {
  orgId: string;
  actorId: string;
  /** Subsidiary scope the caller was granted; null is unrestricted. */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

export interface ProjectCreateOptions {
  /** The quote this project is awarded from (quote award only). */
  awardedFromDocumentId?: string;
}

export interface ProjectCreateResult {
  id: string;
  /** False when the key replayed an earlier identical create. */
  created: boolean;
}

/**
 * A create the rules refuse. `status` 400/422 carry the offending `field`;
 * 404 hides existence (a disabled feature or an out-of-scope legal entity);
 * 409 is an idempotency key reused for a different project.
 */
export class ProjectCreateError extends Error {
  readonly name = "ProjectCreateError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
    readonly field?: string,
    readonly code?: string,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

/** Trimmed string or null ('' and non-strings collapse to null). */
function strOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function uuidOrNull(v: unknown): string | null | "invalid" {
  const s = strOrNull(v);
  if (s === null) return null;
  return isUuid(s) ? s : "invalid";
}

/** Exact numeric(19,4) money string, null, or 'invalid'. */
function moneyOrNull(v: unknown): string | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  const exact = canonicalDecimal(v, 4);
  if (exact === null) return "invalid";
  // canonicalDecimal bounds scale, not magnitude: contract_value is
  // numeric(19,4), so more than 15 whole digits refuses here rather than as
  // a database overflow.
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) return "invalid";
  try {
    return normalizeMoney(exact);
  } catch {
    return "invalid";
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function bad(message: string, field?: string, status: 400 | 422 = 422): ProjectCreateError {
  return new ProjectCreateError(message, status, field);
}

async function partyExists(runner: SqlExecutor, id: string, orgId: string): Promise<boolean> {
  const r = await runner.execute(sql`select 1 from parties where id = ${id} and org_id = ${orgId}`);
  return !!r.rows[0];
}

/** Active parties among `ids` that the caller's subsidiary scope can see. */
async function visibleActiveParties(
  runner: SqlExecutor,
  orgId: string,
  ids: string[],
  scope: ReadonlySet<string> | null,
): Promise<Set<string>> {
  const rows = await runner.execute<{ id: string }>(sql`
    select p.id from parties p
     where p.org_id = ${orgId}
       and p.id = any(${`{${ids.join(",")}}`}::uuid[])
       and p.is_active
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope, { orgWideNull: true })}
  `);
  return new Set(rows.rows.map((row) => row.id));
}

/**
 * Validate a create request and resolve the row image. Reference checks read
 * through `runner`, so a caller inside a transaction validates against the
 * state it is about to write into.
 */
async function resolveProjectRow(
  runner: SqlExecutor,
  ctx: ProjectCreateContext,
  id: string,
  body: ProjectCreateRequest,
  options: ProjectCreateOptions,
): Promise<Record<string, unknown>> {
  const orgId = ctx.orgId;
  // Flags ride raw into boolean columns: PostgreSQL would silently coerce
  // spellings like 'off'/'on' or throw 22P02 on anything else.
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    throw bad("isActive must be a boolean", "isActive", 400);
  }
  if (body.subsidiaryIncludeChildren !== undefined && typeof body.subsidiaryIncludeChildren !== "boolean") {
    throw bad("subsidiaryIncludeChildren must be a boolean", "subsidiaryIncludeChildren", 400);
  }
  if (body.isInternal !== undefined && typeof body.isInternal !== "boolean") {
    throw bad("isInternal must be a boolean", "isInternal", 400);
  }
  const isInternal = body.isInternal === true;
  if (body.status !== undefined && !PROJECT_STATUSES.includes(body.status as ProjectStatus)) {
    throw bad("Invalid status", "status");
  }
  const status = typeof body.status === "string" ? body.status : "active";

  // A nameless record must never persist, and the old draft sentinel name is
  // refused so a create cannot mint a placeholder project.
  const name = strOrNull(body.name) ?? "";
  if (!name || name === "New project") throw bad("name_required", "name");
  const isActive = body.isActive !== false;

  const party = async (raw: unknown, label: string, field: string): Promise<string | null> => {
    if (raw === undefined) return null;
    const v = uuidOrNull(raw);
    if (v === "invalid") throw bad(`Invalid ${label}`, field);
    if (v !== null && !(await partyExists(runner, v, orgId))) {
      throw bad(`${label[0]!.toUpperCase()}${label.slice(1)} not found`, field);
    }
    return v;
  };
  const customerId = await party(body.customerId, "customer", "customerId");
  const foremanId = await party(body.foremanId, "foreman", "foremanId");
  const managerId = await party(body.managerId, "manager", "managerId");
  // Project roles are internal people (the timekeeper rule): an active
  // person party, or an employee party holding an active employment. A
  // customer, vendor, or company party cannot manage a project or run its
  // crew. Subsidiary scope is deliberately not pinned here — the visibility
  // check below still reports an out-of-scope person by name instead.
  if (managerId !== null && !(await pinInternalPerson(runner, orgId, managerId))) {
    throw bad(
      `project manager "${managerId}" must be an active employee or internal person in this organization — choose the manager from the organization's people`,
      "managerId",
    );
  }
  if (foremanId !== null && !(await pinInternalPerson(runner, orgId, foremanId))) {
    throw bad(
      `project foreman "${foremanId}" must be an active employee or internal person in this organization — choose the foreman from the organization's people`,
      "foremanId",
    );
  }
  // Pickers only offer subsidiary-visible active parties: the write agrees,
  // so an out-of-scope customer/foreman/manager is refused by name instead
  // of persisting a cross-subsidiary link the caller can never see again.
  const linked = [customerId, foremanId, managerId].filter((v): v is string => v !== null);
  if (linked.length > 0) {
    const visible = await visibleActiveParties(runner, orgId, linked, ctx.allowedSubsidiaryIds);
    if (customerId !== null && !visible.has(customerId)) {
      throw bad(`project customer "${customerId}" is not visible in your subsidiary scope`, "customerId");
    }
    if (foremanId !== null && !visible.has(foremanId)) {
      throw bad(`project foreman "${foremanId}" is not visible in your subsidiary scope`, "foremanId");
    }
    if (managerId !== null && !visible.has(managerId)) {
      throw bad(`project manager "${managerId}" is not visible in your subsidiary scope`, "managerId");
    }
  }

  let subsidiaryId: string | null = null;
  if (body.subsidiaryId !== undefined) {
    const value = uuidOrNull(body.subsidiaryId);
    if (value === "invalid") throw bad("Invalid subsidiary", "subsidiaryId");
    const scope = ctx.allowedSubsidiaryIds;
    if (scope !== null && (value === null || !scope.has(value))) throw bad("Subsidiary not found", "subsidiaryId");
    if (value) {
      const subsidiary = await runner.execute(sql`
        select 1 from subsidiaries
         where id = ${value} and org_id = ${orgId} and is_active and not is_elimination`);
      if (!subsidiary.rows.length) throw bad("Subsidiary not found", "subsidiaryId");
    }
    subsidiaryId = value;
  }
  const subsidiaryIncludeChildren =
    body.subsidiaryIncludeChildren !== undefined ? body.subsidiaryIncludeChildren === true : true;

  let startsOn: string | null = null;
  if (body.startsOn !== undefined) {
    const s = strOrNull(body.startsOn);
    if (s !== null && !isIsoCalendarDate(s)) throw bad("Invalid start date", "startsOn");
    startsOn = s;
  }
  let endsOn: string | null = null;
  if (body.endsOn !== undefined) {
    const s = strOrNull(body.endsOn);
    if (s !== null && !isIsoCalendarDate(s)) throw bad("Invalid end date", "endsOn");
    endsOn = s;
  }

  // Native project-level invoicing override (a real column, not custom jsonb).
  const invoicingRaw = body.invoicingPreference;
  const invoicingPreference =
    invoicingRaw == null || (typeof invoicingRaw === "object" && Object.values(invoicingRaw).every((v) => v == null))
      ? null
      : (invoicingRaw as Record<string, unknown>);
  // Internal projects bill nothing and invoice no one: a customer or any
  // invoicing configuration on one is refused here (storage re-checks), so a
  // shop target can never be misconfigured into customer billing.
  if (isInternal && customerId !== null) {
    throw bad("An internal project has no customer", "customerId");
  }
  if (isInternal && invoicingPreference !== null) {
    throw bad("Internal projects carry no invoicing configuration", "invoicingPreference");
  }

  const defs = await loadFieldDefs("projects");
  const customResult = validateCustomValues(defs, asRecord(body.custom));
  // The validator names the field in each error ("Label is required"): echo
  // the first one so a required custom field names itself.
  if (!customResult.ok) throw bad(Object.values(customResult.errors)[0] ?? "invalid_custom_fields", "custom");
  // Reference custom values are uuid-shaped here, but nothing yet proves the
  // referenced row belongs to the caller: refuse foreign or dangling ids.
  const unowned = await findUnownedCustomReferences(orgId, defs, customResult.cleaned);
  if (unowned.length > 0) throw bad("unknown_custom_reference", "custom");
  const custom = customResult.cleaned;

  const contractValue = body.contractValue === undefined ? null : moneyOrNull(body.contractValue);
  if (contractValue === "invalid") throw bad(moneyRefusal("Contract value", body.contractValue), "contractValue");

  // Where the improved property sits, as an ISO 3166-2 subdivision code:
  // lien waivers release payment only when their jurisdiction matches it.
  let siteJurisdiction: string | null = null;
  if (body.siteJurisdiction !== undefined && body.siteJurisdiction !== null && body.siteJurisdiction !== "") {
    const canonical = normalizeSubdivisionCode(body.siteJurisdiction);
    if (!canonical) {
      throw bad(
        `unknown site jurisdiction ${JSON.stringify(body.siteJurisdiction)} — use an ISO 3166-2 subdivision code (e.g. US-CA)`,
        "siteJurisdiction",
      );
    }
    siteJurisdiction = canonical;
  }

  // The project type governs the billing classifier; the project stores only
  // the reference.
  let projectTypeId: string | null = null;
  if (body.projectTypeId !== undefined) {
    const v = uuidOrNull(body.projectTypeId);
    if (v === "invalid") throw bad("Invalid project type", "projectTypeId");
    projectTypeId = v;
    if (v) {
      const pt = await runner.execute(sql`select 1 from project_types where id = ${v} and org_id = ${orgId} and is_active`);
      if (pt.rows.length === 0) throw bad("Unknown project type", "projectTypeId");
    }
  }

  return {
    id,
    org_id: orgId,
    name,
    code: strOrNull(body.code),
    customer_id: customerId,
    is_internal: isInternal,
    foreman_id: foremanId,
    manager_id: managerId,
    subsidiary_id: subsidiaryId,
    subsidiary_include_children: subsidiaryIncludeChildren,
    status,
    project_type_id: projectTypeId,
    invoicing_preference: invoicingPreference,
    customer_po_number: strOrNull(body.customerPoNumber),
    contract_value: contractValue,
    starts_on: startsOn,
    ends_on: endsOn,
    notes: strOrNull(body.notes),
    site_jurisdiction: siteJurisdiction,
    is_active: isActive,
    custom,
    // Present only for awarded projects, so replays of projects created
    // before award provenance existed keep comparing against their image.
    ...(options.awardedFromDocumentId ? { awarded_from_document_id: options.awardedFromDocumentId } : {}),
  };
}

/**
 * Create a project inside the caller's open tenant transaction. Takes the
 * feature-gate fence, re-checks the `projects` gate and the caller's
 * legal-entity scope, inserts, and writes the create audit event. A replayed
 * key returns the existing project when the request matches its create image.
 */
export async function createProjectInTransaction(
  runner: SqlExecutor,
  ctx: ProjectCreateContext,
  id: string,
  body: ProjectCreateRequest,
  options: ProjectCreateOptions = {},
): Promise<ProjectCreateResult> {
  if (!isUuid(id)) throw bad("invalid_idempotency_key", undefined, 400);
  const snapshot = await resolveProjectRow(runner, ctx, id, body, options);

  // Serialize against feature toggles, then re-ask the gate: an entry check
  // made outside this transaction may be stale by the time this write lands.
  await acquireOrgFeatureGateLock(runner, ctx.orgId);
  if (!(await isFeatureEnabled(ctx.orgId, "projects", runner))) {
    throw new ProjectCreateError("Projects are turned off for this organization", 404, undefined, "feature_disabled");
  }
  const subsidiaryId = snapshot.subsidiary_id as string | null;
  if (!subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, subsidiaryId)) {
    throw new ProjectCreateError("Project not found", 404, undefined, "scope");
  }

  const prior = (await runner.execute<{ versionId: string | null; after: Record<string, unknown> | null }>(sql`
    select p.operating_profile_version_id as "versionId", a.changes->'after' as after from projects p
    left join lateral (select changes from audit_log where org_id=p.org_id and table_name='projects' and row_id=p.id and action='insert' order by created_at limit 1) a on true
    where p.org_id=${ctx.orgId} and p.id=${id} for share of p`)).rows[0];
  if (prior) {
    if (prior.versionId) await checkPinnedOperatingProfileCommand(runner, ctx.orgId, ctx.actorId, { versionId: prior.versionId, family: 'project', subsidiaryId });
    if (prior.after && ('operating_profile_version_id' in prior.after || body.operatingProfile !== undefined || body.operatingDepartmentId !== undefined)) {
      snapshot.operating_profile_version_id = prior.versionId;
      snapshot.operating_department_id = body.operatingDepartmentId ?? null;
      snapshot.operating_profile_selection = body.operatingProfile ?? null;
    }
  } else {
    const profile = await resolveOperatingProfileForCreate(runner, ctx.orgId, ctx.actorId, { family: 'project', subsidiaryId, selection: body.operatingProfile, departmentId: body.operatingDepartmentId });
    if (profile.versionId || body.operatingProfile !== undefined || body.operatingDepartmentId !== undefined) {
      snapshot.operating_profile_version_id = profile.versionId;
      snapshot.operating_department_id = profile.departmentId;
      snapshot.operating_profile_selection = body.operatingProfile ?? null;
    }
  }

  const s = snapshot;
  const invoicingPreference = s.invoicing_preference as Record<string, unknown> | null;
  const awardedFrom = options.awardedFromDocumentId ?? null;
  const inserted = await runner.execute<{ id: string }>(sql`
    insert into projects
      (id, org_id, name, code, customer_id, foreman_id, manager_id,
       subsidiary_id, subsidiary_include_children, status, project_type_id,
       invoicing_preference, customer_po_number, contract_value,
       starts_on, ends_on, notes, site_jurisdiction, is_active, is_internal, custom,
       awarded_from_document_id, awarded_at, awarded_by, operating_profile_version_id, operating_department_id, created_by, updated_by)
    values
      (${id}, ${ctx.orgId}, ${s.name as string}, ${s.code as string | null},
       ${s.customer_id as string | null}, ${s.foreman_id as string | null}, ${s.manager_id as string | null},
       ${subsidiaryId}, ${s.subsidiary_include_children as boolean}, ${s.status as string}, ${s.project_type_id as string | null},
       ${invoicingPreference === null ? sql`null` : sql`${JSON.stringify(invoicingPreference)}::jsonb`},
       ${s.customer_po_number as string | null}, ${s.contract_value as string | null},
       ${s.starts_on as string | null}, ${s.ends_on as string | null}, ${s.notes as string | null},
       ${s.site_jurisdiction as string | null}, ${s.is_active as boolean}, ${s.is_internal as boolean},
       ${JSON.stringify(s.custom)}::jsonb,
       ${awardedFrom}, ${awardedFrom === null ? sql`null` : sql`now()`}, ${awardedFrom === null ? null : ctx.actorId},
       ${(s.operating_profile_version_id as string | null) ?? null}, ${(s.operating_department_id as string | null) ?? null},
       ${ctx.actorId}, ${ctx.actorId})
    -- A retry is accepted only after the existing audited create image is verified below.
    on conflict (id) do nothing
    returning id
  `);
  if (!inserted.rows[0]) {
    const prior = await runner.execute<{ id: string }>(sql`
      select id from projects where id = ${id} and org_id = ${ctx.orgId}
    `);
    if (!prior.rows[0]) throw new ProjectCreateError("Project not found", 404, undefined, "scope");
    // Compare replays with the immutable create image in the insert audit
    // event, rather than today's row, so an unchanged retry still succeeds
    // after later edits.
    const replay = await resolveIdempotentReplay(runner, {
      orgId: ctx.orgId,
      table: "projects",
      key: id,
      match: snapshot,
    });
    if (replay !== "replay") {
      throw new ProjectCreateError(
        "idempotency_key_conflict",
        409,
        undefined,
        "idempotency_key_conflict",
        "Close and reopen the project form to retry with a fresh idempotency key.",
      );
    }
    return { id, created: false };
  }
  // Header creation moves billing caps, ownership and legal-entity scope, so
  // it carries the same audit row every other material project write does.
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${ctx.orgId}, 'projects', ${id}, 'insert',
            ${JSON.stringify({ before: null, after: snapshot })}::jsonb, ${ctx.actorId}, ${id})
  `);
  return { id, created: true };
}

/** Create a project in its own tenant transaction. */
export async function createProject(
  ctx: ProjectCreateContext,
  id: string,
  body: ProjectCreateRequest,
): Promise<ProjectCreateResult> {
  return withOrgTransaction(ctx.orgId, () => createProjectInTransaction(db, ctx, id, body));
}
