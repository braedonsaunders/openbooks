import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManageOrg } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";

/**
 * Canonical recruiting candidate service (HR-6, 0195): the prospect before
 * they are a party. Creating a candidate refuses a duplicate email within
 * the org unless mergeInto names the existing candidate — then no new
 * record is created, the application attaches to the existing candidate,
 * and a merged event records it. party_id is set ONLY by hire.
 */

export const CANDIDATE_SOURCE_VALUES = ["referral", "job_board", "agency", "direct", "internal", "other"] as const;

export interface CandidateDTO {
  readonly id: string;
  readonly partyId: string | null;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string | null;
  readonly sourceDetail: string | null;
  readonly resumeAttachmentId: string | null;
  readonly consentRecordedAt: string | null;
  readonly isInternal: boolean;
  readonly notes: string | null;
}

type CandidateRow = {
  id: string;
  partyId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  sourceDetail: string | null;
  resumeAttachmentId: string | null;
  consentRecordedAt: string | null;
  isInternal: boolean;
  notes: string | null;
};

const CANDIDATE_COLUMNS = sql`
  id, party_id as "partyId", display_name as "displayName",
  email, phone, source, source_detail as "sourceDetail",
  resume_attachment_id as "resumeAttachmentId",
  consent_recorded_at as "consentRecordedAt",
  is_internal as "isInternal", notes
`;

function toDTO(row: CandidateRow): CandidateDTO {
  return { ...row };
}

export async function loadCandidate(
  exec: SqlExecutor,
  orgId: string,
  candidateId: string,
): Promise<CandidateRow | null> {
  return (await exec.execute<CandidateRow>(sql`
    select ${CANDIDATE_COLUMNS} from hrm_candidates
     where org_id = ${orgId} and id = ${candidateId}
  `)).rows[0] ?? null;
}

/** Case-insensitive email match within the org (the duplicate-email refusal). */
export async function findCandidateByEmail(
  exec: SqlExecutor,
  orgId: string,
  email: string,
): Promise<CandidateRow | null> {
  return (await exec.execute<CandidateRow>(sql`
    select ${CANDIDATE_COLUMNS} from hrm_candidates
     where org_id = ${orgId} and lower(btrim(email)) = lower(btrim(${email}))
     order by created_at limit 1
  `)).rows[0] ?? null;
}

export interface CreateCandidateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly displayName: unknown;
  readonly email?: unknown;
  readonly phone?: unknown;
  readonly source?: unknown;
  readonly sourceDetail?: unknown;
  readonly resumeAttachmentId?: unknown;
  readonly isInternal?: unknown;
  readonly notes?: unknown;
  /**
   The existing candidate to merge into when the email already exists:
   no new record is created and the returned mergedInto names the survivor.
   */
  readonly mergeInto?: unknown;
}

export interface CreateCandidateResult {
  readonly candidate: CandidateDTO;
  /** Set when mergeInto absorbed this create: attach to the survivor. */
  readonly mergedInto: CandidateDTO | null;
}

export async function createCandidate(query: CreateCandidateQuery): Promise<CreateCandidateResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (typeof query.displayName !== "string" || query.displayName.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "candidate display name must be non-blank");
  }
  const email =
    query.email === undefined || query.email === null || query.email === ""
      ? null
      : typeof query.email === "string" && query.email.trim().length > 0
        ? query.email.trim()
        : (() => {
            throw new RecruitingError("INVALID_INPUT", "candidate email must be non-blank when sent");
          })();
  const phone =
    query.phone === undefined || query.phone === null || query.phone === ""
      ? null
      : typeof query.phone === "string" && query.phone.trim().length > 0
        ? query.phone.trim()
        : (() => {
            throw new RecruitingError("INVALID_INPUT", "candidate phone must be non-blank when sent");
          })();
  const source =
    query.source === undefined || query.source === null
      ? null
      : typeof query.source === "string" && (CANDIDATE_SOURCE_VALUES as readonly string[]).includes(query.source)
        ? query.source
        : (() => {
            throw new RecruitingError(
              "INVALID_INPUT",
              `candidate source must be one of ${CANDIDATE_SOURCE_VALUES.join(", ")} — check the source`,
            );
          })();
  const resumeAttachmentId =
    query.resumeAttachmentId === undefined || query.resumeAttachmentId === null
      ? null
      : requireId(query.resumeAttachmentId, "resumeAttachmentId");
  const isInternal = query.isInternal === true;
  const mergeInto =
    query.mergeInto === undefined || query.mergeInto === null ? null : requireId(query.mergeInto, "mergeInto");

  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    if (resumeAttachmentId) {
      const file = (await db.execute<{ one: number }>(sql`
        select 1 as one from files where org_id = ${orgId} and id = ${resumeAttachmentId} limit 1
      `)).rows.length > 0;
      if (!file) {
        throw new RecruitingError("NOT_FOUND", "resume attachment is not visible in this organization — check the reference");
      }
    }
    if (email) {
      const duplicate = await findCandidateByEmail(db, orgId, email);
      if (duplicate) {
        if (!mergeInto || mergeInto !== duplicate.id) {
          throw new RecruitingError(
            "REFUSED",
            `a candidate with this email already exists (${duplicate.displayName}) — pass mergeInto ${duplicate.id} to attach to the existing candidate instead of creating a duplicate`,
          );
        }
        const survivor = await loadCandidate(db, orgId, duplicate.id);
        if (!survivor) {
          throw new RecruitingError("NOT_FOUND", "merge target is not visible in this organization — check the reference");
        }
        return { candidate: toDTO(survivor), mergedInto: toDTO(survivor) };
      }
      if (mergeInto) {
        throw new RecruitingError("NOT_FOUND", "merge target is not visible in this organization — check the reference");
      }
    } else if (mergeInto) {
      throw new RecruitingError("INVALID_INPUT", "mergeInto needs the duplicate email — without an email there is nothing to merge");
    }
    const inserted = (await db.execute<CandidateRow>(sql`
      insert into hrm_candidates
        (org_id, display_name, email, phone, source,
         source_detail, resume_attachment_id, is_internal, notes,
         created_by, updated_by)
      values (${orgId}, ${query.displayName as string}, ${email}, ${phone}, ${source},
              ${typeof query.sourceDetail === "string" ? query.sourceDetail : null},
              ${resumeAttachmentId}, ${isInternal},
              ${typeof query.notes === "string" ? query.notes : null},
              ${actorId}, ${actorId})
      returning ${CANDIDATE_COLUMNS}
    `)).rows[0];
    if (!inserted) {
      throw new RecruitingError("REFUSED", "the candidate was not stored — no row was written; retry the request");
    }
    return { candidate: toDTO(inserted), mergedInto: null };
  });
}

/**
 * Link the hired employee party. Called ONLY from the hire transaction:
 * until hire the candidate is never a party.
 */
export async function linkCandidateParty(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; candidateId: string; partyId: string },
): Promise<void> {
  const updated = (await exec.execute<{ id: string }>(sql`
    update hrm_candidates
       set party_id = ${args.partyId}, updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.candidateId} and party_id is null
    returning id
  `)).rows[0];
  if (!updated) {
    throw new RecruitingError(
      "REFUSED",
      "the candidate is already linked to a party — a candidate becomes an employee exactly once",
    );
  }
}
