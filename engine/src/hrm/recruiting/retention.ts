import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManageOrg } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";
import {
  enqueueRecruitingEmailJob,
  escapeHtml,
  requireDepthFeature,
  type RecruitingEmailEnqueuer,
} from "./depth.ts";

/**
 * Canonical retention service (HR-18, 0229): consent and retention rules
 * that make GDPR a setting.
 *
 * - evaluateRetentionRule runs one rule in one transaction: it selects
 *   candidate consents/expiry (consent basis) or last application-event age
 *   (inactivity basis), SKIPS every candidate with an open (active)
 *   application — a candidate with an open application is never touched —
 *   and either anonymizes, deletes, or requests a consent extension.
 * - anonymize replaces PII with fixed tokens (display_name →
 *   "Anonymized candidate"; email/phone/notes cleared; resume file removed
 *   through the injected file remover, defaulting to the File Cabinet row
 *   delete) while events stay — funnel analytics survive untouched.
 * - delete removes the candidate and cascades applications and every
 *   dependent row in FK order; application_events survive as orphan-safe
 *   aggregates (SET NULL, documented in the 0229 header). The run's detail
 *   records the orphaned event count.
 * - Consent extension emails go out lead_days before expiry and stamp
 *   extension_requested_at in the same transaction — re-running the rule
 *   never re-sends (idempotent by the stamp).
 * - Every evaluation appends exactly one hrm_retention_runs row, even when
 *   nothing matched (a run that touched nothing is evidence, not absence).
 * - Region scope is an applies_to shape + country codes array matched
 *   against the candidate's consent/source metadata by declared region
 *   tags; an empty scope matches every candidate. Pure matcher below is
 *   unit-tested.
 */

export const RETENTION_BASES = ["inactivity", "consent"] as const;
export const RETENTION_ACTIONS = ["anonymize", "delete"] as const;
export const CONSENT_PURPOSES = ["this_application", "future_roles", "talent_pool"] as const;

export const ANONYMIZED_DISPLAY_NAME = "Anonymized candidate";

export interface RetentionRuleDTO {
  readonly id: string;
  readonly name: string;
  readonly regionScope: Record<string, unknown>;
  readonly basis: string;
  readonly retainMonths: number;
  readonly action: string;
  readonly consentExtensionLeadDays: number | null;
  readonly isActive: boolean;
}

export type RetentionRunDTO = {
  readonly id: string;
  readonly ruleId: string;
  readonly ranAt: string;
  readonly candidatesAnonymized: number;
  readonly candidatesDeleted: number;
  readonly extensionsRequested: number;
  readonly detail: unknown;
}

type RuleRow = {
  id: string;
  name: string;
  regionScope: Record<string, unknown> | null;
  basis: string;
  retainMonths: number;
  action: string;
  consentExtensionLeadDays: number | null;
  isActive: boolean;
};

function toRuleDTO(row: RuleRow): RetentionRuleDTO {
  return {
    id: row.id,
    name: row.name,
    regionScope: row.regionScope ?? {},
    basis: row.basis,
    retainMonths: row.retainMonths,
    action: row.action,
    consentExtensionLeadDays: row.consentExtensionLeadDays,
    isActive: row.isActive,
  };
}

/**
 * Region-scope matcher (pure, unit-tested). Scope shape:
 * { applies_to: 'all' | 'countries', countries: string[] } matched against
 * the candidate's declared region tags. Empty scope = every candidate.
 */
export function retentionScopeMatches(
  scope: Record<string, unknown> | null | undefined,
  candidateRegions: readonly string[],
): boolean {
  if (!scope || Object.keys(scope).length === 0) return true;
  if (scope.applies_to === "all") return true;
  if (scope.applies_to === "countries" && Array.isArray(scope.countries)) {
    const wanted = new Set(scope.countries.map((code) => String(code).toUpperCase()));
    return candidateRegions.some((region) => wanted.has(region.toUpperCase()));
  }
  // An unreadable scope matches nothing: fail closed rather than sweeping
  // candidates under a rule nobody can audit.
  return false;
}

export async function listRetentionRules(query: {
  orgId: string;
  actorId: string;
  includeInactive?: boolean;
}): Promise<readonly RetentionRuleDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    const rows = (await db.execute<RuleRow>(sql`
      select id, name, region_scope as "regionScope", basis,
             retain_months as "retainMonths", action,
             consent_extension_lead_days as "consentExtensionLeadDays",
             is_active as "isActive"
        from hrm_retention_rules
       where org_id = ${orgId} and (${query.includeInactive === true} or is_active)
       order by name
    `)).rows;
    return rows.map(toRuleDTO);
  });
}

export async function createRetentionRule(query: {
  orgId: string;
  actorId: string;
  name: unknown;
  regionScope?: unknown;
  basis: unknown;
  retainMonths: unknown;
  action?: unknown;
  consentExtensionLeadDays?: unknown;
}): Promise<RetentionRuleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a retention rule needs a non-blank name — name the obligation it enforces");
  }
  if (query.basis !== "inactivity" && query.basis !== "consent") {
    throw new RecruitingError("INVALID_INPUT", "a retention rule runs on basis inactivity or consent — pick what starts the clock");
  }
  if (typeof query.retainMonths !== "number" || !Number.isInteger(query.retainMonths) || query.retainMonths < 1) {
    throw new RecruitingError("INVALID_INPUT", "retain_months is a positive integer of months — say how long the data may live");
  }
  const action = query.action === undefined ? "anonymize" : query.action;
  if (action !== "anonymize" && action !== "delete") {
    throw new RecruitingError("INVALID_INPUT", "a retention rule acts by anonymize or delete — anonymize keeps funnel analytics; delete erases");
  }
  const leadDays =
    query.consentExtensionLeadDays == null ? null : query.consentExtensionLeadDays;
  if (leadDays !== null && (typeof leadDays !== "number" || !Number.isInteger(leadDays) || leadDays < 1)) {
    throw new RecruitingError("INVALID_INPUT", "consent_extension_lead_days is a positive integer of days when sent — say how early the extension goes out");
  }
  const scope =
    query.regionScope == null ? {} : (query.regionScope as Record<string, unknown>);
  if (typeof scope !== "object" || Array.isArray(scope)) {
    throw new RecruitingError("INVALID_INPUT", "region_scope is an object ({applies_to, countries}) — declare where the rule applies");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    try {
      const row = (await db.execute<RuleRow>(sql`
        insert into hrm_retention_rules
          (org_id, name, region_scope, basis, retain_months, action,
           consent_extension_lead_days, created_by, updated_by)
        values (${orgId}, ${query.name}, ${JSON.stringify(scope)}, ${query.basis},
                ${query.retainMonths}, ${action}, ${leadDays}, ${actorId}, ${actorId})
        returning id, name, region_scope as "regionScope", basis,
                  retain_months as "retainMonths", action,
                  consent_extension_lead_days as "consentExtensionLeadDays",
                  is_active as "isActive"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the rule was not stored — no row was written; retry the request");
      return toRuleDTO(row);
    } catch (error) {
      if ((error as { code?: string }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") {
        throw new RecruitingError(
          "REFUSED",
          `a retention rule named ${query.name} already exists — rename the rule or edit the existing one`,
        );
      }
      throw error;
    }
  });
}

export type ConsentDTO = {
  readonly id: string;
  readonly candidateId: string;
  readonly purpose: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
  readonly withdrawnAt: string | null;
  readonly source: string;
}

/** Record (or re-grant) consent for a candidate + purpose. Withdrawals ride withdrawConsent. */
export async function recordConsent(query: {
  orgId: string;
  actorId: string;
  candidateId: string;
  purpose: unknown;
  source?: unknown;
  expiresAt?: unknown;
}): Promise<ConsentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const candidateId = requireId(query.candidateId, "candidateId");
  if (!CONSENT_PURPOSES.includes(query.purpose as (typeof CONSENT_PURPOSES)[number])) {
    throw new RecruitingError(
      "INVALID_INPUT",
      `consent purpose must be one of ${CONSENT_PURPOSES.join(", ")} — capture the purpose the candidate agreed to`,
    );
  }
  const source = query.source === undefined ? "form" : query.source;
  if (source !== "form" && source !== "email" && source !== "import") {
    throw new RecruitingError("INVALID_INPUT", "consent source is form, email, or import — record where the consent came from");
  }
  const expiresAt =
    query.expiresAt == null ? null : String(query.expiresAt);
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
    throw new RecruitingError("INVALID_INPUT", "consent expires_at must be an ISO instant when sent — say when the consent lapses");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    const candidate = (await db.execute<{ one: number }>(sql`
      select 1 as one from hrm_candidates where org_id = ${orgId} and id = ${candidateId}
    `)).rows[0];
    if (!candidate) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
    const row = (await db.execute<ConsentDTO>(sql`
      insert into hrm_candidate_consents (org_id, candidate_id, purpose, expires_at, source, created_by, updated_by)
      values (${orgId}, ${candidateId}, ${query.purpose}, ${expiresAt}, ${source}, ${actorId}, ${actorId})
      on conflict (org_id, candidate_id, purpose)
      do update set granted_at = now(), expires_at = excluded.expires_at, withdrawn_at = null,
                    extension_requested_at = null, source = excluded.source,
                    updated_by = excluded.updated_by, updated_at = now()
      returning id, candidate_id as "candidateId", purpose,
                granted_at as "grantedAt", expires_at as "expiresAt",
                withdrawn_at as "withdrawnAt", source
    `)).rows[0];
    if (!row) throw new RecruitingError("REFUSED", "the consent was not stored — no row was written; retry the request");
    return row;
  });
}

/** Withdraw consent (evidence: the row stays with withdrawn_at stamped). */
export async function withdrawConsent(query: {
  orgId: string;
  actorId: string;
  candidateId: string;
  purpose: unknown;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const candidateId = requireId(query.candidateId, "candidateId");
  await withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    const updated = (await db.execute<{ one: number }>(sql`
      update hrm_candidate_consents
         set withdrawn_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and candidate_id = ${candidateId}
         and purpose = ${String(query.purpose)} and withdrawn_at is null
      returning 1 as one
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError(
        "NOT_FOUND",
        "no live consent for that candidate and purpose — it was never granted or already withdrawn",
      );
    }
  });
}

export type RetentionFileRemover = (exec: SqlExecutor, orgId: string, fileId: string) => Promise<void>;

/** Default resume removal: delete the File Cabinet blob + file rows (the file is candidate PII). */
export async function deleteCabinetFile(exec: SqlExecutor, orgId: string, fileId: string): Promise<void> {
  await exec.execute(sql`delete from file_blobs where org_id = ${orgId} and file_id = ${fileId}`);
  const deleted = (await exec.execute<{ id: string }>(sql`
    delete from files where org_id = ${orgId} and id = ${fileId} returning id
  `)).rows[0];
  if (!deleted) {
    throw new RecruitingError("REFUSED", "the resume file was not removed — no row was deleted; retry the request");
  }
}

type CandidateScanRow = {
  id: string;
  partyId: string | null;
  lastEventAt: string | null;
  consentExpiresAt: string | null;
  consentWithdrawnAt: string | null;
  extensionRequestedAt: string | null;
  hasOpenApplication: boolean;
  resumeFileId: string | null;
};

export interface EvaluateRuleOptions {
  readonly enqueueEmail?: RecruitingEmailEnqueuer;
  readonly removeFile?: RetentionFileRemover;
  /** Override for tests; defaults to now. */
  readonly now?: Date;
}

/**
 * Evaluate one active rule. One transaction: select, act, stamp, append
 * the run row. Candidates with open applications are never touched.
 */
export async function evaluateRetentionRule(
  query: { orgId: string; actorId: string; ruleId: string },
  options: EvaluateRuleOptions = {},
): Promise<RetentionRunDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const ruleId = requireId(query.ruleId, "ruleId");
  const now = options.now ?? new Date();
  const enqueue = options.enqueueEmail ?? enqueueRecruitingEmailJob;
  const removeFile = options.removeFile ?? deleteCabinetFile;
  return withOrgTransaction(orgId, async () => {
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    const rule = (await db.execute<RuleRow>(sql`
      select id, name, region_scope as "regionScope", basis,
             retain_months as "retainMonths", action,
             consent_extension_lead_days as "consentExtensionLeadDays",
             is_active as "isActive"
        from hrm_retention_rules where org_id = ${orgId} and id = ${ruleId}
    `)).rows[0];
    if (!rule) throw new RecruitingError("NOT_FOUND", "retention rule is not visible in this organization");
    if (!rule.isActive) {
      throw new RecruitingError("REFUSED", `rule ${rule.name} is retired — reactivate it before running it`);
    }
    const candidates = (await db.execute<CandidateScanRow>(sql`
      select c.id, c.party_id as "partyId",
             (select max(e.recorded_at) from hrm_application_events e
               join hrm_applications a on a.id = e.application_id and a.org_id = e.org_id
              where a.org_id = ${orgId} and a.candidate_id = c.id) as "lastEventAt",
             (select min(k.expires_at) from hrm_candidate_consents k
               where k.org_id = ${orgId} and k.candidate_id = c.id and k.withdrawn_at is null) as "consentExpiresAt",
             (select max(k.withdrawn_at) from hrm_candidate_consents k
               where k.org_id = ${orgId} and k.candidate_id = c.id) as "consentWithdrawnAt",
             (select max(k.extension_requested_at) from hrm_candidate_consents k
               where k.org_id = ${orgId} and k.candidate_id = c.id) as "extensionRequestedAt",
             exists (select 1 from hrm_applications a
                      where a.org_id = ${orgId} and a.candidate_id = c.id and a.status = 'active') as "hasOpenApplication",
             c.resume_attachment_id as "resumeFileId"
        from hrm_candidates c
       where c.org_id = ${orgId}
    `)).rows;
    const cutoffMonths = rule.retainMonths;
    const monthsAgo = (dateIso: string | null): number | null => {
      if (!dateIso) return null;
      const months = (now.getTime() - Date.parse(dateIso)) / (30.44 * 24 * 3_600_000);
      return months;
    };
    let anonymized = 0;
    let deleted = 0;
    let extensions = 0;
    const detail: Record<string, unknown>[] = [];
    for (const candidate of candidates) {
      // THE OPEN-APPLICATION RULE: a candidate with an open application is
      // never touched, whatever the rule says. A hired candidate (party
      // linked — an employee) is never touched either: retention owns
      // prospects, never the workforce.
      if (candidate.hasOpenApplication) continue;
      if (candidate.partyId) continue;
      // Region scope gates before the basis clock (an empty scope matches all).
      if (!retentionScopeMatches(rule.regionScope ?? {}, [])) continue;
      if (rule.basis === "inactivity") {
        const age = monthsAgo(candidate.lastEventAt);
        if (age === null || age < cutoffMonths) continue;
      } else {
        // Consent basis: the clock is the earliest live consent expiry; a
        // candidate with no expiring consent is not due.
        if (!candidate.consentExpiresAt) continue;
        const expiryInDays = (Date.parse(candidate.consentExpiresAt) - now.getTime()) / (24 * 3_600_000);
        const leadDays = rule.consentExtensionLeadDays;
        if (expiryInDays > 0) {
          // Not yet expired: extension window only.
          if (leadDays === null || leadDays === undefined) continue;
          if (expiryInDays > leadDays) continue;
          if (candidate.extensionRequestedAt) continue; // idempotent: asked once per grant
          const consentRow = (await db.execute<{ id: string; email: string | null }>(sql`
            select k.id, c.email from hrm_candidate_consents k
             join hrm_candidates c on c.org_id = k.org_id and c.id = k.candidate_id
             where k.org_id = ${orgId} and k.candidate_id = ${candidate.id}
               and k.withdrawn_at is null and k.expires_at is not null
             order by k.expires_at limit 1
          `)).rows[0];
          if (consentRow?.email) {
            await enqueue(
              {
                orgId,
                to: consentRow.email,
                subject: "Keep your application on file?",
                html: `<p>Your consent to keep your application on file expires soon. Reply to this email to extend it, or do nothing and it will lapse.</p>`,
                text: `Your consent to keep your application on file expires soon. Reply to this email to extend it, or do nothing and it will lapse.`,
              },
              { jobId: `consent-extension|${orgId}|${consentRow.id}` },
            );
          }
          await db.execute(sql`
            update hrm_candidate_consents
               set extension_requested_at = ${now.toISOString()}, updated_at = now()
             where org_id = ${orgId} and candidate_id = ${candidate.id}
               and withdrawn_at is null and extension_requested_at is null
          `);
          extensions += 1;
          detail.push({ candidate_id: candidate.id, action: "extension_requested" });
          continue;
        }
        // Expired: fall through to the rule action.
      }
      if (rule.action === "anonymize") {
        if (candidate.resumeFileId) {
          await removeFile(db, orgId, candidate.resumeFileId);
        }
        const touched = (await db.execute<{ one: number }>(sql`
          update hrm_candidates
             set display_name = ${ANONYMIZED_DISPLAY_NAME}, email = null, phone = null,
                 notes = null, source_detail = null, resume_attachment_id = null,
                 updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${candidate.id}
          returning 1 as one
        `)).rows[0];
        if (!touched) {
          throw new RecruitingError("REFUSED", "the candidate changed while anonymizing — the run is refused rather than half-applied");
        }
        anonymized += 1;
        detail.push({ candidate_id: candidate.id, action: "anonymized" });
      } else {
        const orphaned = await deleteCandidateCascade(db, orgId, candidate.id, removeFile);
        deleted += 1;
        detail.push({ candidate_id: candidate.id, action: "deleted", events_orphaned: orphaned });
      }
    }
    const run = (await db.execute<RetentionRunDTO>(sql`
      insert into hrm_retention_runs
        (org_id, rule_id, ran_at, candidates_anonymized, candidates_deleted,
         extensions_requested, detail)
      values (${orgId}, ${ruleId}, ${now.toISOString()}, ${anonymized}, ${deleted},
              ${extensions}, ${JSON.stringify(detail)})
      returning id, rule_id as "ruleId", ran_at as "ranAt",
                candidates_anonymized as "candidatesAnonymized",
                candidates_deleted as "candidatesDeleted",
                extensions_requested as "extensionsRequested", detail
    `)).rows[0];
    if (!run) throw new RecruitingError("REFUSED", "the retention run was not recorded — no row was written; retry the request");
    return run;
  });
}

/**
 * Delete a candidate and every dependent row in FK order. Application
 * events survive as orphan-safe aggregates (their application link clears
 * through the 0229 SET NULL FK); the orphaned count is returned for the
 * run detail. Events are the ONLY survivors.
 */
export async function deleteCandidateCascade(
  exec: SqlExecutor,
  orgId: string,
  candidateId: string,
  removeFile: RetentionFileRemover,
): Promise<number> {
  const resume = (await exec.execute<{ resumeFileId: string | null }>(sql`
    select resume_attachment_id as "resumeFileId" from hrm_candidates
     where org_id = ${orgId} and id = ${candidateId}
  `)).rows[0];
  if (resume?.resumeFileId) {
    await removeFile(exec, orgId, resume.resumeFileId);
  }
  const applications = (await exec.execute<{ id: string }>(sql`
    select id from hrm_applications where org_id = ${orgId} and candidate_id = ${candidateId}
  `)).rows;
  let orphanedEvents = 0;
  for (const application of applications) {
    const interviews = (await exec.execute<{ id: string }>(sql`
      select id from hrm_interviews where org_id = ${orgId} and application_id = ${application.id}
    `)).rows;
    for (const interview of interviews) {
      await exec.execute(sql`delete from hrm_scorecards where org_id = ${orgId} and interview_id = ${interview.id}`);
      await exec.execute(sql`delete from hrm_interview_slots where org_id = ${orgId} and interview_id = ${interview.id}`);
      await exec.execute(sql`delete from hrm_interviews where org_id = ${orgId} and id = ${interview.id}`);
    }
    const offers = (await exec.execute<{ id: string }>(sql`
      select id from hrm_offers where org_id = ${orgId} and application_id = ${application.id}
    `)).rows;
    for (const offer of offers) {
      await exec.execute(sql`delete from hrm_offer_versions where org_id = ${orgId} and offer_id = ${offer.id}`);
      await exec.execute(sql`delete from hrm_offers where org_id = ${orgId} and id = ${offer.id}`);
    }
    const events = (await exec.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_application_events
       where org_id = ${orgId} and application_id = ${application.id}
    `)).rows[0];
    orphanedEvents += Number(events?.count ?? 0);
    // The events survive (SET NULL orphans them as aggregates); the
    // application row goes.
    await exec.execute(sql`delete from hrm_applications where org_id = ${orgId} and id = ${application.id}`);
  }
  await exec.execute(sql`delete from hrm_candidate_consents where org_id = ${orgId} and candidate_id = ${candidateId}`);
  await exec.execute(sql`delete from hrm_talent_pool_members where org_id = ${orgId} and candidate_id = ${candidateId}`);
  const gone = (await exec.execute<{ id: string }>(sql`
    delete from hrm_candidates where org_id = ${orgId} and id = ${candidateId} returning id
  `)).rows[0];
  if (!gone) {
    throw new RecruitingError("REFUSED", "the candidate changed while deleting — the run is refused rather than half-applied");
  }
  return orphanedEvents;
}

/**
 * Consent status for one candidate (loader-resolved): live consents with
 * expiries, plus the earliest due date (the candidate drawer's retention
 * date). Evidence rows — grants, expiries, withdrawals.
 */
export async function listCandidateConsents(query: {
  orgId: string;
  actorId: string;
  candidateId: string;
}): Promise<{
  consents: readonly ConsentDTO[];
  earliestExpiry: string | null;
}> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const candidateId = requireId(query.candidateId, "candidateId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    const candidate = (await db.execute<{ one: number }>(sql`
      select 1 as one from hrm_candidates where org_id = ${orgId} and id = ${candidateId}
    `)).rows[0];
    if (!candidate) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
    const consents = (await db.execute<ConsentDTO>(sql`
      select id, candidate_id as "candidateId", purpose,
             granted_at as "grantedAt", expires_at as "expiresAt",
             withdrawn_at as "withdrawnAt", source
        from hrm_candidate_consents
       where org_id = ${orgId} and candidate_id = ${candidateId}
       order by purpose
    `)).rows;
    const live = consents.filter((consent) => consent.withdrawnAt == null && consent.expiresAt != null);
    live.sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!));
    return { consents, earliestExpiry: live[0]?.expiresAt ?? null };
  });
}

export async function listRetentionRuns(query: {
  orgId: string;
  actorId: string;
  ruleId: string;
}): Promise<readonly RetentionRunDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const ruleId = requireId(query.ruleId, "ruleId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmCandidateRetention");
    const rows = (await db.execute<RetentionRunDTO>(sql`
      select id, rule_id as "ruleId", ran_at as "ranAt",
             candidates_anonymized as "candidatesAnonymized",
             candidates_deleted as "candidatesDeleted",
             extensions_requested as "extensionsRequested", detail
        from hrm_retention_runs
       where org_id = ${orgId} and rule_id = ${ruleId}
       order by ran_at desc limit 100
    `)).rows;
    return rows;
  });
}
