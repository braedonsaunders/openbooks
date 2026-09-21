import { sql } from "drizzle-orm";
import {
  loadOwnEmploymentIds,
  loadTeamEmploymentIdsForManager,
  requireEmploymentOrTeamSubject,
  requireHrmCertificationsManage,
  requireHrmCertificationsRead,
} from "../authorization.ts";
import { businessToday } from "../../platform/business-date.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { HrmQualificationError } from "./errors.ts";
import {
  HRM_CERTIFICATIONS_FEATURE,
  addMonthsUtc,
  assertQualificationsFeature,
  projectDerivedStatus,
  requireDate,
  requireId,
  requireText,
  runInCallerTransaction,
  type DerivedQualificationStatus,
  type SqlExecutor,
  type StoredQualificationStatus,
} from "./shared.ts";
import { loadSettings, type QualificationType } from "./types.ts";

/**
 * The worker qualification ledger (HR-14, hrm_worker_qualifications +
 * hrm_qualification_events).
 *
 * record refuses an expires_on before issued_on, refuses a type the org
 * has not declared (or has retired), and refuses evidence-required types
 * recorded with no file attached. verify flips pending_verification to
 * valid (hrm.certifications.manage). renew writes a NEW row and links
 * the old one in the renewed event — never an overwrite. revoke needs a
 * reason and freezes the row: a revoked qualification cannot be verified
 * or renewed, only replaced by a new record. Reads project
 * expiring/expired from expires_on and the type's lead days; storage
 * never holds derived state.
 */

export interface WorkerQualification {
  readonly id: string;
  readonly employmentId: string;
  readonly type: QualificationType;
  readonly identifier: string | null;
  readonly issuedOn: string;
  readonly expiresOn: string | null;
  readonly storedStatus: StoredQualificationStatus;
  /** Projected at read — never persisted. */
  readonly status: DerivedQualificationStatus;
  readonly evidenceFileId: string | null;
  readonly verifiedBy: string | null;
  readonly verifiedAt: string | null;
  readonly notes: string | null;
}

export interface QualificationEvent {
  readonly id: string;
  readonly qualificationId: string;
  readonly relatedQualificationId: string | null;
  readonly kind: string;
  readonly actorId: string | null;
  readonly reason: string | null;
  readonly recordedAt: string;
}

type LedgerRow = {
  id: string;
  employment_id: string;
  type_id: string;
  type_code: string;
  type_name: string;
  type_category: string;
  type_issuing_body: string | null;
  type_validity_months: number | null;
  type_renewal_lead_days: number;
  type_requires_evidence: boolean;
  type_is_active: boolean;
  identifier: string | null;
  issued_on: string;
  expires_on: string | null;
  status: StoredQualificationStatus;
  evidence_file_id: string | null;
  verified_by: string | null;
  verified_at: string | null;
  notes: string | null;
};

const LEDGER_COLS = sql`
  q.id, q.employment_id, q.type_id,
  t.code as type_code, t.name as type_name, t.category as type_category,
  t.issuing_body as type_issuing_body, t.validity_months as type_validity_months,
  t.renewal_lead_days as type_renewal_lead_days,
  t.requires_evidence as type_requires_evidence, t.is_active as type_is_active,
  q.identifier, q.issued_on::text, q.expires_on::text,
  q.status, q.evidence_file_id::text, q.verified_by::text, q.verified_at::text,
  q.notes`;

function toQualification(row: LedgerRow, today: string): WorkerQualification {
  return {
    id: row.id,
    employmentId: row.employment_id,
    type: {
      id: row.type_id,
      code: row.type_code,
      name: row.type_name,
      category: row.type_category,
      issuingBody: row.type_issuing_body,
      validityMonths: row.type_validity_months,
      renewalLeadDays: row.type_renewal_lead_days,
      requiresEvidence: row.type_requires_evidence,
      isActive: row.type_is_active,
    },
    identifier: row.identifier,
    issuedOn: row.issued_on,
    expiresOn: row.expires_on,
    storedStatus: row.status,
    status: projectDerivedStatus({
      stored: row.status,
      expiresOn: row.expires_on,
      leadDays: row.type_renewal_lead_days,
      today,
    }),
    evidenceFileId: row.evidence_file_id,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    notes: row.notes,
  };
}

async function writeEvent(
  exec: SqlExecutor,
  args: {
    orgId: string;
    qualificationId: string;
    relatedQualificationId?: string | null;
    kind: string;
    actorId: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into hrm_qualification_events
      (org_id, qualification_id, related_qualification_id, kind, actor_id, reason)
    values (${args.orgId}::uuid, ${args.qualificationId}::uuid,
            ${args.relatedQualificationId ?? null}::uuid, ${args.kind},
            ${args.actorId}::uuid, ${args.reason ?? null})
    returning id
  `)).rows[0]?.id;
  if (!inserted) {
    throw new HrmQualificationError("The qualification event was not stored — no row was written; retry the action.");
  }
}

async function loadLedgerRow(
  exec: SqlExecutor,
  orgId: string,
  qualificationId: string,
): Promise<LedgerRow | null> {
  const rows = (await exec.execute<LedgerRow>(sql`
    select ${LEDGER_COLS}
      from hrm_worker_qualifications q
      join hrm_qualification_types t
        on t.org_id = q.org_id and t.id = q.type_id
     where q.org_id = ${orgId}::uuid and q.id = ${qualificationId}::uuid
  `)).rows;
  return rows[0] ?? null;
}

async function loadTypeRow(
  exec: SqlExecutor,
  orgId: string,
  typeId: string,
): Promise<
  | {
      id: string;
      code: string;
      validity_months: number | null;
      requires_evidence: boolean;
      is_active: boolean;
    }
  | null
> {
  const rows = (await exec.execute<{
    id: string;
    code: string;
    validity_months: number | null;
    requires_evidence: boolean;
    is_active: boolean;
  }>(sql`
    select id, code, validity_months, requires_evidence, is_active
      from hrm_qualification_types
     where org_id = ${orgId}::uuid and id = ${typeId}::uuid
  `)).rows;
  return rows[0] ?? null;
}

async function assertEvidenceInOrg(
  exec: SqlExecutor,
  orgId: string,
  fileId: string,
): Promise<void> {
  const rows = (await exec.execute<{ id: string }>(sql`
    select id from files where org_id = ${orgId}::uuid and id = ${fileId}::uuid
  `)).rows;
  if (!rows[0]) {
    throw new HrmQualificationError(
      "The evidence file is not in this organization — upload it to this org's File Cabinet first, then attach it.",
    );
  }
}

async function assertEmploymentInOrg(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<void> {
  const rows = (await exec.execute<{ id: string }>(sql`
    select id from worker_employments where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
  `)).rows;
  if (!rows[0]) {
    throw new HrmQualificationError(
      "The employment record was not found in this organization — qualifications belong to employment records, never to bare parties.",
    );
  }
}

export interface RecordQualificationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly typeId: string;
  readonly identifier?: string | null;
  readonly issuedOn: string;
  /** Null + an expiring type defaults from validity_months at save. */
  readonly expiresOn?: string | null;
  readonly evidenceFileId?: string | null;
  readonly notes?: string | null;
}

export async function recordQualification(
  exec: SqlExecutor,
  input: RecordQualificationInput,
): Promise<WorkerQualification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const typeId = requireId(input.typeId, "typeId");
  const issuedOn = requireDate(input.issuedOn, "issuedOn");
  const expiresOn = input.expiresOn === undefined ? undefined : input.expiresOn === null ? null : requireDate(input.expiresOn, "expiresOn");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
    await assertEmploymentInOrg(tx, orgId, employmentId);
    const type = await loadTypeRow(tx, orgId, typeId);
    if (!type) {
      throw new HrmQualificationError(
        "The qualification type is not declared in this organization — declare it under Company Settings → HRM → Qualification types first.",
      );
    }
    if (!type.is_active) {
      throw new HrmQualificationError(
        `Qualification type "${type.code}" is retired — reactivate it under Company Settings → HRM → Qualification types, or record against its replacement.`,
      );
    }
    if (expiresOn !== undefined && expiresOn !== null && expiresOn < issuedOn) {
      throw new HrmQualificationError(
        `expiry ${expiresOn} is before issue ${issuedOn} — a qualification cannot expire before it is issued.`,
      );
    }
    const evidenceFileId = input.evidenceFileId ?? null;
    if (type.requires_evidence && !evidenceFileId) {
      throw new HrmQualificationError(
        `Qualification type "${type.code}" requires evidence — attach the certificate or license file before recording.`,
      );
    }
    if (evidenceFileId) await assertEvidenceInOrg(tx, orgId, evidenceFileId);
    // Defaulted at save when the caller leaves it null and the type
    // expires; stored, never computed at read.
    const storedExpiresOn =
      expiresOn === undefined || expiresOn === null
        ? type.validity_months === null
          ? null
          : addMonthsUtc(issuedOn, type.validity_months)
        : expiresOn;
    const identifier = input.identifier?.trim() ? input.identifier.trim() : null;
    const notes = input.notes?.trim() ? input.notes.trim() : null;
    try {
      const rows = (await tx.execute<LedgerRow>(sql`
        insert into hrm_worker_qualifications
          (org_id, employment_id, type_id, identifier, issued_on, expires_on,
           status, evidence_file_id, notes, created_by, updated_by)
        values (${orgId}::uuid, ${employmentId}::uuid, ${typeId}::uuid,
                ${identifier}, ${issuedOn}::date, ${storedExpiresOn}::date,
                'pending_verification', ${evidenceFileId}::uuid, ${notes},
                ${actorId}::uuid, ${actorId}::uuid)
        returning id
      `)).rows;
      const createdId = rows[0]?.id;
      if (!createdId) throw new HrmQualificationError("The qualification was not stored — no row was written; retry the action.");
      await writeEvent(tx, {
        orgId,
        qualificationId: createdId,
        kind: "recorded",
        actorId,
        reason: notes,
      });
      const created = await loadLedgerRow(tx, orgId, createdId);
      if (!created) throw new HrmQualificationError("The qualification was not stored — it cannot be read back; retry the action.");
      return toQualification(created, await businessToday(orgId));
    } catch (error) {
      if (error instanceof HrmQualificationError) throw error;
      if (error instanceof Error && /duplicate key|unique/i.test(error.message)) {
        throw new HrmQualificationError(
          "This employment already holds that qualification type with the same issue date — renew it instead of recording a duplicate.",
        );
      }
      throw error;
    }
  });
}

export interface VerifyQualificationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly qualificationId: string;
  readonly reason?: string | null;
}

/** Verification stays HR's: the person may attach evidence, only HR verifies. */
export async function verifyQualification(
  exec: SqlExecutor,
  input: VerifyQualificationInput,
): Promise<WorkerQualification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const qualificationId = requireId(input.qualificationId, "qualificationId");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
    const current = await loadLedgerRow(tx, orgId, qualificationId);
    if (!current) {
      throw new HrmQualificationError(
        "The qualification was not found in this organization — it may belong to another org; refresh the ledger and try again.",
      );
    }
    if (current.status === "revoked") {
      throw new HrmQualificationError(
        "A revoked qualification cannot be verified — record a new qualification once the worker re-qualifies.",
      );
    }
    if (current.status === "valid") {
      throw new HrmQualificationError("The qualification is already verified — no second verification is recorded.");
    }
    const rows = (await tx.execute<{ id: string }>(sql`
      update hrm_worker_qualifications
         set status = 'valid', verified_by = ${actorId}::uuid, verified_at = now(),
             updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${qualificationId}::uuid
         and status = 'pending_verification'
       returning id
    `)).rows;
    if (!rows[0]) {
      throw new HrmQualificationError("The qualification changed under you — refresh the ledger and try again.");
    }
    await writeEvent(tx, {
      orgId,
      qualificationId,
      kind: "verified",
      actorId,
      reason: input.reason?.trim() ? input.reason.trim() : null,
    });
    const updated = await loadLedgerRow(tx, orgId, qualificationId);
    if (!updated) throw new HrmQualificationError("The qualification cannot be read back — retry the action.");
    return toQualification(updated, await businessToday(orgId));
  });
}

export interface RenewQualificationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly qualificationId: string;
  readonly issuedOn: string;
  readonly expiresOn?: string | null;
  readonly evidenceFileId?: string | null;
  readonly identifier?: string | null;
  readonly notes?: string | null;
}

/**
 * Renewal is a NEW row with the old one linked in the renewed event —
 * never an overwrite, so the full credential history survives.
 */
export async function renewQualification(
  exec: SqlExecutor,
  input: RenewQualificationInput,
): Promise<WorkerQualification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const qualificationId = requireId(input.qualificationId, "qualificationId");
  const issuedOn = requireDate(input.issuedOn, "issuedOn");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
    const current = await loadLedgerRow(tx, orgId, qualificationId);
    if (!current) {
      throw new HrmQualificationError(
        "The qualification was not found in this organization — it may belong to another org; refresh the ledger and try again.",
      );
    }
    if (current.status === "revoked") {
      throw new HrmQualificationError(
        "A revoked qualification cannot be renewed — record a brand-new qualification once the worker re-qualifies.",
      );
    }
    const created = await recordQualification(tx, {
      orgId,
      actorId,
      employmentId: current.employment_id,
      typeId: current.type_id,
      identifier: input.identifier ?? current.identifier,
      issuedOn,
      expiresOn: input.expiresOn ?? null,
      evidenceFileId: input.evidenceFileId ?? current.evidence_file_id,
      notes: input.notes ?? null,
    });
    // recordQualification runs its own grant + feature checks (same keys)
    // and its own transaction runner, which joins this transaction.
    await writeEvent(tx, {
      orgId,
      qualificationId: created.id,
      relatedQualificationId: qualificationId,
      kind: "renewed",
      actorId,
      reason: input.notes?.trim() ? input.notes.trim() : null,
    });
    return created;
  });
}

export interface RevokeQualificationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly qualificationId: string;
  readonly reason: string;
}

export async function revokeQualification(
  exec: SqlExecutor,
  input: RevokeQualificationInput,
): Promise<WorkerQualification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const qualificationId = requireId(input.qualificationId, "qualificationId");
  const reason = requireText(input.reason, "reason");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
    const current = await loadLedgerRow(tx, orgId, qualificationId);
    if (!current) {
      throw new HrmQualificationError(
        "The qualification was not found in this organization — it may belong to another org; refresh the ledger and try again.",
      );
    }
    if (current.status === "revoked") {
      throw new HrmQualificationError("The qualification is already revoked — a second revocation is not recorded.");
    }
    const rows = (await tx.execute<{ id: string }>(sql`
      update hrm_worker_qualifications
         set status = 'revoked', updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${qualificationId}::uuid
         and status <> 'revoked'
       returning id
    `)).rows;
    if (!rows[0]) {
      throw new HrmQualificationError("The qualification changed under you — refresh the ledger and try again.");
    }
    await writeEvent(tx, { orgId, qualificationId, kind: "revoked", actorId, reason });
    const updated = await loadLedgerRow(tx, orgId, qualificationId);
    if (!updated) throw new HrmQualificationError("The qualification cannot be read back — retry the action.");
    return toQualification(updated, await businessToday(orgId));
  });
}

export interface AttachEvidenceInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly qualificationId: string;
  readonly fileId: string;
}

/**
 * The person may attach evidence to their own pending qualification
 * (verification stays HR's); HR may attach to any row they manage.
 */
export async function attachEvidence(
  exec: SqlExecutor,
  input: AttachEvidenceInput,
): Promise<WorkerQualification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const qualificationId = requireId(input.qualificationId, "qualificationId");
  const fileId = requireId(input.fileId, "fileId");
  return runInCallerTransaction(exec, async (tx) => {
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
    const current = await loadLedgerRow(tx, orgId, qualificationId);
    if (!current) {
      throw new HrmQualificationError(
        "The qualification was not found in this organization — it may belong to another org; refresh the ledger and try again.",
      );
    }
    // HR's path first; the person's own pending rows second. Strangers
    // keep the unchanged not-found shape — no new information leaks.
    let allowed = false;
    try {
      await requireHrmCertificationsManage(tx, orgId, actorId);
      allowed = true;
    } catch (error) {
      if (!(error instanceof HrmAuthorizationError)) throw error;
      const own = await loadOwnEmploymentIds(tx, orgId, actorId);
      allowed = own.includes(current.employment_id) && current.status === "pending_verification";
    }
    if (!allowed) {
      throw new HrmQualificationError(
        "Evidence can be attached by HR, or by the holder while the qualification is pending verification.",
      );
    }
    await assertEvidenceInOrg(tx, orgId, fileId);
    const rows = (await tx.execute<{ id: string }>(sql`
      update hrm_worker_qualifications
         set evidence_file_id = ${fileId}::uuid,
             updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${qualificationId}::uuid
       returning id
    `)).rows;
    if (!rows[0]) {
      throw new HrmQualificationError("The qualification changed under you — refresh the ledger and try again.");
    }
    const updated = await loadLedgerRow(tx, orgId, qualificationId);
    if (!updated) throw new HrmQualificationError("The qualification cannot be read back — retry the action.");
    return toQualification(updated, await businessToday(orgId));
  });
}

export interface ListQualificationsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId?: string;
  readonly typeId?: string;
  /** Read projection: expiring | expired | pending | valid. */
  readonly status?: DerivedQualificationStatus;
  /** HR reads everything; anyone else reads own (+ team reports'). */
  readonly scopeAll?: boolean;
}

export async function listQualifications(
  exec: SqlExecutor,
  input: ListQualificationsInput,
): Promise<WorkerQualification[]> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
  let employmentIds: string[] | null = null;
  if (input.scopeAll !== false) {
    try {
      await requireHrmCertificationsRead(exec, orgId, actorId);
    } catch (error) {
      // Only authorization denials fall through to self/team scope —
      // infrastructure failures propagate untouched.
      if (!(error instanceof HrmAuthorizationError)) throw error;
      employmentIds = await selfAndTeamEmploymentIds(exec, orgId, actorId);
    }
  } else {
    employmentIds = await selfAndTeamEmploymentIds(exec, orgId, actorId);
  }
  if (input.employmentId) {
    const wanted = requireId(input.employmentId, "employmentId");
    if (employmentIds !== null && !employmentIds.includes(wanted)) {
      // Prove the subject through the structural gate so a manager's
      // report resolves and a stranger keeps the employment refusal.
      await requireEmploymentOrTeamSubject(exec, orgId, actorId, wanted);
    }
    employmentIds = [wanted];
  }
  const rows = (await exec.execute<LedgerRow>(sql`
    select ${LEDGER_COLS}
      from hrm_worker_qualifications q
      join hrm_qualification_types t
        on t.org_id = q.org_id and t.id = q.type_id
     where q.org_id = ${orgId}::uuid
       and (${employmentIds === null}::boolean
            or q.employment_id in (select jsonb_array_elements_text(${JSON.stringify(employmentIds ?? [])}::jsonb)::uuid))
       and (${input.typeId ?? null}::uuid is null or q.type_id = ${input.typeId ?? null}::uuid)
     order by q.expires_on nulls last, q.issued_on desc
  `)).rows;
  const today = await businessToday(orgId);
  const projected = rows.map((row) => toQualification(row, today));
  if (!input.status) return projected;
  return projected.filter((q) => q.status === input.status);
}

export async function selfAndTeamEmploymentIds(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<string[]> {
  // Self + structural team scope: the actor's own employments plus their
  // direct reports' as of today. No grant on its own confers this — the
  // caller must hold hrm.self.read (managers read reports, never strangers).
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.self.read"))) {
    throw new HrmAuthorizationError(
      "Qualification access requires the hrm.certifications.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const own = await loadOwnEmploymentIds(exec, orgId, actorId);
  if (own.length === 0) return [];
  const today = await businessToday(orgId);
  const team = await loadTeamEmploymentIdsForManager(exec, orgId, own, today);
  return [...new Set([...own, ...team])];
}

export async function listQualificationEvents(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; qualificationId: string },
): Promise<QualificationEvent[]> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const qualificationId = requireId(input.qualificationId, "qualificationId");
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualifications");
  try {
    await requireHrmCertificationsRead(exec, orgId, actorId);
  } catch (error) {
    if (!(error instanceof HrmAuthorizationError)) throw error;
    const current = await loadLedgerRow(exec, orgId, qualificationId);
    if (!current) {
      throw new HrmQualificationError(
        "The qualification was not found in this organization — it may belong to another org; refresh the ledger and try again.",
      );
    }
    const allowed = await selfAndTeamEmploymentIds(exec, orgId, actorId);
    if (!allowed.includes(current.employment_id)) {
      throw new HrmQualificationError(
        "Qualification access requires the hrm.certifications.read permission — ask an administrator to grant it in /admin/roles.",
      );
    }
  }
  const rows = (await exec.execute<{
    id: string;
    qualification_id: string;
    related_qualification_id: string | null;
    kind: string;
    actor_id: string | null;
    reason: string | null;
    recorded_at: string;
  }>(sql`
    select id, qualification_id::text, related_qualification_id::text,
           kind, actor_id::text, reason, recorded_at::text
      from hrm_qualification_events
     where org_id = ${orgId}::uuid and qualification_id = ${qualificationId}::uuid
     order by recorded_at, id
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    qualificationId: row.qualification_id,
    relatedQualificationId: row.related_qualification_id,
    kind: row.kind,
    actorId: row.actor_id,
    reason: row.reason,
    recordedAt: row.recorded_at,
  }));
}

export { loadSettings };
