import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { organizationCurrencyAvailable } from "../organization/currency-options.ts";
import { subsidiaryVisibleFilter, ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { payrollPack } from "./packs.ts";
import { PayrollError } from "./error.ts";
import { canonicalCompensationPackageDefinition, compensationPackageAssignmentInputs, evaluateCompensationPackage, validateCompensationPackage, type CompensationPackageDefinition, type CompensationPackageEvaluationContext } from "./compensation-package.ts";
import type { CompensationRuleComponent } from "./compensation-rules.ts";

export interface CompensationPackageActor { readonly orgId: string; readonly actorId: string }
export type CompensationPackageAuthorship = readonly { actorId: string; partyId: string | null }[];
export type CompensationPackageRecord = {
  readonly id: string; readonly subsidiaryId: string; readonly code: string; readonly name: string;
  readonly description: string | null; readonly country: string; readonly currency: string;
  readonly status: "active" | "retired"; readonly revision: number;
}
export type CompensationPackageVersion = {
  readonly id: string; readonly packageId: string; readonly version: number;
  readonly effectiveFrom: string; readonly effectiveTo: string | null;
  readonly definition: CompensationPackageDefinition; readonly definitionHash: string;
  readonly status: "draft" | "submitted" | "approved" | "rejected";
  readonly authorship: CompensationPackageAuthorship;
  readonly submittedBy: string | null; readonly decidedBy: string | null; readonly createdBy: string; readonly revision: number;
}
export type CompensationPackageAssignment = {
  readonly id: string; readonly packageId: string; readonly versionId: string; readonly employmentId: string;
  readonly employeePartyId: string; readonly subsidiaryId: string; readonly effectiveFrom: string; readonly effectiveTo: string | null;
  readonly inputs: Readonly<Record<string, string | boolean>>;
  readonly status: "draft" | "submitted" | "active" | "rejected" | "ended" | "cancelled";
  readonly authorship: CompensationPackageAuthorship;
  readonly submittedBy: string | null; readonly decidedBy: string | null; readonly createdBy: string; readonly revision: number;
}
const PACKAGE_COLUMNS = sql`id,subsidiary_id as "subsidiaryId",code,name,description,country,currency,status,revision`;
const VERSION_COLUMNS = sql`id,package_id as "packageId",version,effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",
 definition,definition_hash as "definitionHash",status,authorship,submitted_by as "submittedBy",decided_by as "decidedBy",created_by as "createdBy",revision`;
const ASSIGNMENT_COLUMNS = sql`id,package_id as "packageId",version_id as "versionId",employment_id as "employmentId",
 employee_party_id as "employeePartyId",subsidiary_id as "subsidiaryId",effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",
 inputs,status,authorship,submitted_by as "submittedBy",decided_by as "decidedBy",created_by as "createdBy",revision`;

function identifier(value: unknown, name: string): string {
  if (!isUuid(value)) throw new PayrollError(`A valid ${name} is required — reload the record and choose its native reference.`);
  return value;
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > max) throw new PayrollError(`${name} requires 1 through ${max} characters — supply a concise value before saving.`);
  return value.trim();
}
function dates(from: unknown, to: unknown): { effectiveFrom: string; effectiveTo: string | null } {
  if (!isIsoCalendarDate(from) || (to !== null && !isIsoCalendarDate(to)) || (typeof to === "string" && to < from)) throw new PayrollError("Compensation effective dates must be valid and ordered — choose an end on or after the start, or leave it open.");
  return { effectiveFrom: from, effectiveTo: to };
}
function revision(current: { revision: number }, expected: unknown): void {
  if (!Number.isSafeInteger(expected) || current.revision !== expected) throw new PayrollError("Compensation revision changed — reload the record and review its current terms before saving.");
}
function one<T>(rows: T[]): T {
  if (rows.length !== 1) throw new ScopeNotFoundError();
  return rows[0]!;
}
function actor(query: CompensationPackageActor): void { identifier(query.orgId, "organization"); identifier(query.actorId, "actor"); }

/** Preserve our storage refusals without exposing SQL, parameters or unrelated database errors. */
async function packageTransaction<T>(orgId: string, action: () => Promise<T>): Promise<T> {
  try { return await withOrgTransaction(orgId, action); }
  catch (error) {
    const visited = new Set<object>();
    let detail: unknown = error;
    while (detail && typeof detail === "object" && !visited.has(detail)) {
      visited.add(detail);
      const cause = detail as { code?: string; constraint?: string; where?: string; message?: string; cause?: unknown };
      if (cause.code === "P0001" && /PL\/pgSQL function (?:public\.)?payroll_compensation_(?:configuration|assignment|calculation)_guard\(\)/.test(cause.where ?? "") && typeof cause.message === "string") throw new PayrollError(cause.message);
      if (cause.constraint?.startsWith("payroll_compensation_")) {
        if (cause.code === "23505") throw new PayrollError("This package code or version already exists — reload the package register and choose a unique code or create a new version.");
        if (cause.code === "23P01") throw new PayrollError("The employment already has approved compensation for this window — end the existing assignment and use non-overlapping successor dates.");
        if (cause.code === "23503") throw new PayrollError("A compensation reference is no longer available — reload the package and choose its current native employer, employment and approved version.");
        if (cause.code === "23514") throw new PayrollError("The compensation configuration is invalid — review its effective dates, required values and lifecycle state before saving.");
      }
      if (cause.code === "40001" || cause.code === "40P01") throw new PayrollError("Compensation configuration changed during this operation — reload its current state and retry; this operation saved no changes.");
      detail = cause.cause;
    }
    throw error;
  }
}

/** A row lock also detects a changed snapshot under REPEATABLE READ; a bare advisory lock cannot do that. */
export async function lockCompensationPackageConfiguration(tx: SqlExecutor, orgId: string, mode: "read" | "write" = "read"): Promise<string> {
  const rows = (await tx.execute<{ revision: string }>(sql`select revision::text as revision from payroll_compensation_configuration
    where org_id=${orgId} ${mode === "write" ? sql`for update` : sql`for share`}`)).rows;
  if (rows.length !== 1) throw new PayrollError("Compensation configuration is missing — complete the database upgrade before calculating or saving payroll.");
  return rows[0]!.revision;
}
async function begin(query: CompensationPackageActor, permission: string, write: boolean): Promise<ReadonlySet<string> | null> {
  if (!await actorHasPermission(db, query.orgId, query.actorId, permission)) throw new ScopeNotFoundError();
  if (!await lockAndCheckOrgFeature(db, query.orgId, "payroll")) throw new PayrollError("Payroll is disabled — enable it on Company Settings → Features before using compensation packages.");
  await lockCompensationPackageConfiguration(db, query.orgId, write ? "write" : "read");
  return actorAllowedSubsidiaryIds(db, query.orgId, query.actorId);
}
async function packageRecord(query: CompensationPackageActor, packageId: string, permission: string, write: boolean): Promise<CompensationPackageRecord> {
  const scope = await begin(query, permission, write);
  const row = one((await db.execute<CompensationPackageRecord>(sql`select ${PACKAGE_COLUMNS} from payroll_compensation_packages
    where org_id=${query.orgId} and id=${identifier(packageId, "package")} ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)}
    ${write ? sql`for update` : sql`for share`}`)).rows);
  await lockActorCommandAuthority(db, query.orgId, query.actorId, row.subsidiaryId, permission);
  return row;
}
export async function compensationPackageComponents(tx: SqlExecutor, orgId: string, definition: CompensationPackageDefinition): Promise<CompensationRuleComponent[]> {
  if (!Array.isArray(definition?.rules) || definition.rules.length < 1 || definition.rules.length > 64) throw new PayrollError("A compensation package needs 1 through 64 component rules — add a rule or reduce the package size.");
  const ids = definition.rules.map((rule) => identifier(rule.componentId, "pay component"));
  return (await tx.execute<{ [K in keyof CompensationRuleComponent]: CompensationRuleComponent[K] }>(sql`select org_id as "orgId",id,code,kind,country,system_key as "systemKey",is_active as "isActive"
    from pay_components where org_id=${orgId} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) order by id for share`)).rows;
}
async function checkedDefinition(orgId: string, pack: CompensationPackageRecord, definition: CompensationPackageDefinition): Promise<string> {
  if (definition?.orgId !== orgId || definition.country !== pack.country || definition.currency !== pack.currency) throw new PayrollError("The package definition belongs to a different organization, country or currency — use this package's employer context.");
  return validateCompensationPackage(definition, await compensationPackageComponents(db, orgId, definition));
}
async function versionRecord(orgId: string, packageId: string, versionId: string, write = true): Promise<CompensationPackageVersion> {
  return one((await db.execute<CompensationPackageVersion>(sql`select ${VERSION_COLUMNS} from payroll_compensation_versions
    where org_id=${orgId} and package_id=${packageId} and id=${identifier(versionId, "package version")} ${write ? sql`for update` : sql`for share`}`)).rows);
}

export async function listCompensationPackages(query: CompensationPackageActor): Promise<CompensationPackageRecord[]> {
  actor(query);
  return packageTransaction(query.orgId, async () => {
    const scope = await begin(query, "payroll.read", false);
    return (await db.execute<CompensationPackageRecord>(sql`select ${PACKAGE_COLUMNS} from payroll_compensation_packages
      where org_id=${query.orgId} ${subsidiaryVisibleFilter(sql`subsidiary_id`, scope)} order by code,id`)).rows;
  });
}
export async function getCompensationPackage(query: CompensationPackageActor & { packageId: string }): Promise<{
  package: CompensationPackageRecord; versions: CompensationPackageVersion[]; assignments: CompensationPackageAssignment[];
}> {
  actor(query);
  return packageTransaction(query.orgId, async () => {
    const pack = await packageRecord(query, query.packageId, "payroll.read", false);
    const versions = (await db.execute<CompensationPackageVersion>(sql`select ${VERSION_COLUMNS} from payroll_compensation_versions
      where org_id=${query.orgId} and package_id=${pack.id} order by version desc`)).rows;
    const assignments = (await db.execute<CompensationPackageAssignment>(sql`select ${ASSIGNMENT_COLUMNS} from payroll_compensation_assignments
      where org_id=${query.orgId} and package_id=${pack.id} order by effective_from desc,id`)).rows;
    return { package: pack, versions, assignments };
  });
}
export async function createCompensationPackage(query: CompensationPackageActor & { subsidiaryId: string; code: string; name: string; description?: string | null; country: string; currency: string; reason: string }): Promise<CompensationPackageRecord> {
  actor(query); identifier(query.subsidiaryId, "employer");
  const code = text(query.code, "Package code", 64), name = text(query.name, "Package name", 160), reason = text(query.reason, "Reason", 2000);
  if (!/^[A-Z]{2}$/.test(query.country) || !/^[A-Z]{3}$/.test(query.currency)) throw new PayrollError("Choose an ISO payroll country and currency for this package.");
  if (!payrollPack(query.country).installable) throw new PayrollError("Choose an installed payroll country before configuring its compensation package.");
  if (query.description != null && (typeof query.description !== "string" || query.description.length > 2000)) throw new PayrollError("Package description allows at most 2000 characters — shorten it before saving.");
  return packageTransaction(query.orgId, async () => {
    await begin(query, "payroll.manage", true);
    await lockActorCommandAuthority(db, query.orgId, query.actorId, query.subsidiaryId, "payroll.manage");
    const employer = (await db.execute(sql`select id from subsidiaries where org_id=${query.orgId} and id=${query.subsidiaryId} and is_active and not is_elimination for share`)).rows[0];
    if (!employer) throw new ScopeNotFoundError();
    if (!await organizationCurrencyAvailable(db, query.orgId, query.currency, query.subsidiaryId)) throw new PayrollError("Choose an enabled currency for the package employer — foreign currencies require Company Settings → Features → Multi-currency.");
    return one((await db.execute<CompensationPackageRecord>(sql`insert into payroll_compensation_packages
      (org_id,subsidiary_id,code,name,description,country,currency,reason,created_by,updated_by)
      values(${query.orgId},${query.subsidiaryId},${code},${name},${query.description ?? null},${query.country},${query.currency},${reason},${query.actorId},${query.actorId}) returning ${PACKAGE_COLUMNS}`)).rows);
  });
}
export async function updateCompensationPackage(query: CompensationPackageActor & { packageId: string; expectedRevision: number; name: string; description: string | null; retire: boolean; reason: string }): Promise<CompensationPackageRecord> {
  actor(query); const name = text(query.name, "Package name", 160), reason = text(query.reason, "Reason", 2000);
  if (query.description !== null && (typeof query.description !== "string" || query.description.length > 2000)) throw new PayrollError("Package description allows at most 2000 characters — shorten it before saving.");
  if (typeof query.retire !== "boolean") throw new PayrollError("Choose whether to retire this package before saving.");
  return packageTransaction(query.orgId, async () => {
    const pack = await packageRecord(query, query.packageId, "payroll.manage", true); revision(pack, query.expectedRevision);
    if (pack.status !== "active") throw new PayrollError("This package is retired — create a new package; existing approved employee terms remain in force.");
    return one((await db.execute<CompensationPackageRecord>(sql`update payroll_compensation_packages set name=${name},description=${query.description},status=${query.retire ? "retired" : "active"},revision=revision+1,
      reason=${reason},updated_by=${query.actorId},updated_at=now() where org_id=${query.orgId} and id=${pack.id} and revision=${query.expectedRevision} returning ${PACKAGE_COLUMNS}`)).rows);
  });
}
export async function saveCompensationPackageVersion(query: CompensationPackageActor & { packageId: string; versionId?: string; expectedRevision?: number;
  effectiveFrom: string; effectiveTo: string | null; definition: CompensationPackageDefinition; reason: string }): Promise<CompensationPackageVersion> {
  actor(query); const window = dates(query.effectiveFrom, query.effectiveTo), reason = text(query.reason, "Reason", 2000);
  return packageTransaction(query.orgId, async () => {
    const pack = await packageRecord(query, query.packageId, "payroll.manage", true);
    if (pack.status !== "active") throw new PayrollError("The package is retired — create a new package before authoring future terms.");
    const hash = await checkedDefinition(query.orgId, pack, query.definition);
    const definition = canonicalJson(canonicalCompensationPackageDefinition(query.definition));
    if (query.versionId) {
      const version = await versionRecord(query.orgId, pack.id, query.versionId); revision(version, query.expectedRevision);
      if (version.status !== "draft") throw new PayrollError("This version is frozen — create a new draft version to change its terms.");
      return one((await db.execute<CompensationPackageVersion>(sql`update payroll_compensation_versions set effective_from=${window.effectiveFrom},effective_to=${window.effectiveTo},
        definition=${definition}::jsonb,definition_hash=${hash},revision=revision+1,reason=${reason},updated_by=${query.actorId},updated_at=now()
        where org_id=${query.orgId} and id=${version.id} and revision=${query.expectedRevision} returning ${VERSION_COLUMNS}`)).rows);
    }
    return one((await db.execute<CompensationPackageVersion>(sql`insert into payroll_compensation_versions
      (org_id,package_id,version,effective_from,effective_to,definition,definition_hash,reason,created_by,updated_by)
      select ${query.orgId},${pack.id},coalesce(max(version),0)+1,${window.effectiveFrom}::date,${window.effectiveTo}::date,${definition}::jsonb,${hash},${reason},${query.actorId},${query.actorId}
      from payroll_compensation_versions where org_id=${query.orgId} and package_id=${pack.id} returning ${VERSION_COLUMNS}`)).rows);
  });
}
async function independentDecision(orgId: string, actorId: string, createdBy: string, submittedBy: string | null, authors: CompensationPackageAuthorship, employeePartyId?: string): Promise<void> {
  const ids = [...new Set([actorId, createdBy, submittedBy, ...authors.map((row) => row.actorId)].filter((id): id is string => id !== null))].sort();
  const identities = (await db.execute<{ id: string; partyId: string | null; isActive: boolean }>(sql`select id,party_id as "partyId",is_active as "isActive" from users
    where org_id=${orgId} and id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) order by id for share`)).rows;
  const approver = identities.find((row) => row.id === actorId);
  if (!approver?.isActive || !approver.partyId) throw new PayrollError("Compensation approval needs a resolved person identity — link the approver to their native person record before deciding.");
  if (ids.some((id) => id !== actorId && !identities.find((row) => row.id === id)?.partyId)) throw new PayrollError("Compensation authorship needs resolved person identities — link the author and submitter to their native person records before independent approval.");
  if (actorId === createdBy || actorId === submittedBy || authors.some((row) => row.actorId === actorId || row.partyId === approver.partyId) || identities.some((row) => row.id !== actorId && row.partyId === approver.partyId) || employeePartyId === approver.partyId) throw new PayrollError("The author, submitter and affected employee cannot approve this compensation change — choose an independent approver.");
}
export async function transitionCompensationPackageVersion(query: CompensationPackageActor & { packageId: string; versionId: string; expectedRevision: number; action: "submit" | "approve" | "reject"; reason: string }): Promise<CompensationPackageVersion> {
  actor(query); const reason = text(query.reason, "Reason", 2000);
  if (!["submit", "approve", "reject"].includes(query.action)) throw new PayrollError("Choose submit, approve or reject for this version.");
  return packageTransaction(query.orgId, async () => {
    const pack = await packageRecord(query, query.packageId, query.action === "submit" ? "payroll.manage" : "hrm.compensation.approve", true);
    const version = await versionRecord(query.orgId, pack.id, query.versionId); revision(version, query.expectedRevision);
    if (pack.status !== "active" || version.status !== (query.action === "submit" ? "draft" : "submitted")) throw new PayrollError("This package version cannot make that transition — reload its current state and act on an active package draft or submitted proposal.");
    if (query.action !== "reject" && await checkedDefinition(query.orgId, pack, version.definition) !== version.definitionHash) throw new PayrollError("The stored package definition does not match its evidence — create and verify a new draft version before approving.");
    if (query.action !== "submit") await independentDecision(query.orgId, query.actorId, version.createdBy, version.submittedBy, version.authorship);
    return one((await db.execute<CompensationPackageVersion>(sql`update payroll_compensation_versions set
      status=${query.action === "submit" ? "submitted" : query.action === "approve" ? "approved" : "rejected"},
      submitted_by=${query.action === "submit" ? query.actorId : version.submittedBy},submitted_at=case when ${query.action === "submit"} then now() else submitted_at end,
      decided_by=${query.action === "submit" ? null : query.actorId},decided_at=case when ${query.action === "submit"} then null else now() end,
      revision=revision+1,reason=${reason},updated_by=${query.actorId},updated_at=now()
      where org_id=${query.orgId} and id=${version.id} and revision=${query.expectedRevision} returning ${VERSION_COLUMNS}`)).rows);
  });
}
export async function saveCompensationPackageAssignment(query: CompensationPackageActor & { packageId: string; versionId: string; employmentId: string;
  assignmentId?: string; expectedRevision?: number; effectiveFrom: string; effectiveTo: string | null; inputs: Readonly<Record<string, unknown>>; reason: string }): Promise<CompensationPackageAssignment> {
  actor(query); identifier(query.employmentId, "employment"); const window = dates(query.effectiveFrom, query.effectiveTo), reason = text(query.reason, "Reason", 2000);
  return packageTransaction(query.orgId, async () => {
    const pack = await packageRecord(query, query.packageId, "payroll.manage", true);
    if (pack.status !== "active") throw new PayrollError("The package is retired — choose an active package for future employee assignments.");
    const version = await versionRecord(query.orgId, pack.id, query.versionId);
    if (version.status !== "approved") throw new PayrollError("Choose an approved package version before assigning its employee terms.");
    if (await checkedDefinition(query.orgId, pack, version.definition) !== version.definitionHash) throw new PayrollError("The package definition does not match its approval evidence — choose a verified approved version.");
    const employment = one((await db.execute<{ workerPartyId: string }>(sql`select worker_party_id as "workerPartyId" from worker_employments
      where org_id=${query.orgId} and id=${query.employmentId} and employer_subsidiary_id=${pack.subsidiaryId} for share`)).rows);
    const inputs = compensationPackageAssignmentInputs(version.definition, query.inputs);
    await checkAssignmentSubject(query.orgId, pack, version, query.employmentId, employment.workerPartyId, window);
    if (query.assignmentId) {
      const assignment = one((await db.execute<CompensationPackageAssignment>(sql`select ${ASSIGNMENT_COLUMNS} from payroll_compensation_assignments where org_id=${query.orgId} and package_id=${pack.id} and id=${identifier(query.assignmentId, "assignment")} for update`)).rows);
      revision(assignment, query.expectedRevision);
      if (assignment.status !== "draft") throw new PayrollError("This employee assignment is frozen — create an effective-dated successor for changed terms.");
      return one((await db.execute<CompensationPackageAssignment>(sql`update payroll_compensation_assignments set version_id=${version.id},employment_id=${query.employmentId},employee_party_id=${employment.workerPartyId},
        effective_from=${window.effectiveFrom},effective_to=${window.effectiveTo},inputs=${canonicalJson(inputs)}::jsonb,revision=revision+1,reason=${reason},updated_by=${query.actorId},updated_at=now()
        where org_id=${query.orgId} and id=${assignment.id} and revision=${query.expectedRevision} returning ${ASSIGNMENT_COLUMNS}`)).rows);
    }
    return one((await db.execute<CompensationPackageAssignment>(sql`insert into payroll_compensation_assignments
      (org_id,package_id,version_id,employment_id,employee_party_id,subsidiary_id,effective_from,effective_to,inputs,reason,created_by,updated_by)
      values(${query.orgId},${pack.id},${version.id},${query.employmentId},${employment.workerPartyId},${pack.subsidiaryId},${window.effectiveFrom},${window.effectiveTo},${canonicalJson(inputs)}::jsonb,${reason},${query.actorId},${query.actorId}) returning ${ASSIGNMENT_COLUMNS}`)).rows);
  });
}
async function checkAssignmentSubject(orgId: string, pack: CompensationPackageRecord, version: CompensationPackageVersion, employmentId: string, workerPartyId: string, window: { effectiveFrom: string; effectiveTo: string | null }): Promise<void> {
  if (window.effectiveFrom < version.effectiveFrom || (version.effectiveTo !== null && (window.effectiveTo === null || window.effectiveTo > version.effectiveTo))) throw new PayrollError("The employee assignment exceeds its approved version window — choose dates covered by that version.");
  const coverage = (await db.execute(sql`select employment_id from worker_employment_versions where org_id=${orgId} and employment_id=${employmentId} and recorded_until is null and status in ('active','on_leave')
    group by employment_id having range_agg(daterange(effective_from,effective_to,'[)')) @> daterange(${window.effectiveFrom}::date,${window.effectiveTo}::date,'[]')`)).rows[0];
  if (!coverage) throw new PayrollError("The employment does not cover this compensation assignment — choose a covered window or record verified employment history through its native workflow.");
  const profile = (await db.execute<{ country: string }>(sql`select country from employee_payroll_profiles where org_id=${orgId} and employee_party_id=${workerPartyId} and employment_id=${employmentId} and is_active for share`)).rows;
  if (profile.length !== 1 || profile[0]!.country !== pack.country) throw new PayrollError("The employee needs one active payroll profile matching this package country — configure the native employment payroll profile before assigning the package.");
}
export async function transitionCompensationPackageAssignment(query: CompensationPackageActor & { packageId: string; assignmentId: string; expectedRevision: number;
  action: "submit" | "approve" | "reject" | "cancel" | "end"; effectiveTo?: string; reason: string }): Promise<CompensationPackageAssignment> {
  actor(query); const reason = text(query.reason, "Reason", 2000);
  if (!["submit", "approve", "reject", "cancel", "end"].includes(query.action)) throw new PayrollError("Choose a supported compensation assignment action.");
  return packageTransaction(query.orgId, async () => {
    const decide = query.action === "approve" || query.action === "reject";
    const pack = await packageRecord(query, query.packageId, decide ? "hrm.compensation.approve" : "payroll.manage", true);
    const row = one((await db.execute<CompensationPackageAssignment>(sql`select ${ASSIGNMENT_COLUMNS} from payroll_compensation_assignments where org_id=${query.orgId} and package_id=${pack.id} and id=${identifier(query.assignmentId, "assignment")} for update`)).rows);
    revision(row, query.expectedRevision);
    const expectedStatus = decide ? "submitted" : query.action === "end" ? "active" : "draft";
    if (row.status !== expectedStatus || (pack.status !== "active" && query.action !== "end" && query.action !== "cancel")) throw new PayrollError("This compensation assignment cannot make that transition — reload its current state before acting.");
    const version = await versionRecord(query.orgId, pack.id, row.versionId);
    if (query.action === "submit" || query.action === "approve") {
      if (await checkedDefinition(query.orgId, pack, version.definition) !== version.definitionHash) throw new PayrollError("The package definition no longer matches its approval evidence — choose a verified approved version.");
      compensationPackageAssignmentInputs(version.definition, row.inputs);
      await checkAssignmentSubject(query.orgId, pack, version, row.employmentId, row.employeePartyId, { effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo });
    }
    if (decide) await independentDecision(query.orgId, query.actorId, row.createdBy, row.submittedBy, row.authorship, row.employeePartyId);
    let effectiveTo = row.effectiveTo;
    if (query.action === "end") {
      effectiveTo = dates(row.effectiveFrom, query.effectiveTo).effectiveTo;
      if (effectiveTo === null || (row.effectiveTo !== null && effectiveTo > row.effectiveTo)) throw new PayrollError("Ending an assignment must shorten its current window — choose an end date within its approved terms.");
    }
    if (query.action === "approve") {
      const overlap = (await db.execute(sql`select id from payroll_compensation_assignments where org_id=${query.orgId} and employment_id=${row.employmentId} and status in ('active','ended')
        and daterange(effective_from,effective_to,'[]') && daterange(${row.effectiveFrom}::date,${row.effectiveTo}::date,'[]') limit 1`)).rows[0];
      if (overlap) throw new PayrollError("The employment already has approved compensation for this window — end the existing assignment and use non-overlapping successor dates.");
    }
    const status = query.action === "approve" ? "active" : query.action === "reject" ? "rejected" : query.action === "submit" ? "submitted" : query.action === "cancel" ? "cancelled" : "ended";
    return one((await db.execute<CompensationPackageAssignment>(sql`update payroll_compensation_assignments set status=${status},effective_to=${effectiveTo},
      submitted_by=${query.action === "submit" ? query.actorId : row.submittedBy},submitted_at=case when ${query.action === "submit"} then now() else submitted_at end,
      decided_by=${decide ? query.actorId : row.decidedBy},decided_at=case when ${decide} then now() else decided_at end,
      revision=revision+1,reason=${reason},updated_by=${query.actorId},updated_at=now() where org_id=${query.orgId} and id=${row.id} and revision=${query.expectedRevision} returning ${ASSIGNMENT_COLUMNS}`)).rows);
  });
}
export async function previewCompensationPackageVersion(query: CompensationPackageActor & { packageId: string; versionId: string; context: CompensationPackageEvaluationContext }) {
  actor(query);
  return packageTransaction(query.orgId, async () => {
    const pack = await packageRecord(query, query.packageId, "payroll.read", false);
    const version = await versionRecord(query.orgId, pack.id, query.versionId, false);
    const context = query.context;
    if (context.effectiveFrom < version.effectiveFrom || (version.effectiveTo !== null && (context.effectiveTo === null || context.effectiveTo > version.effectiveTo))) throw new PayrollError("Preview coverage must fall within the selected package version — choose covered effective dates.");
    return evaluateCompensationPackage(version.definition, await compensationPackageComponents(db, query.orgId, version.definition), context);
  });
}
