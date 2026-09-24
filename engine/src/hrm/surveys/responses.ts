import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { loadActorPartyId, requireHrmSurveysManage } from "../authorization.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { HrmSurveysError } from "../documents/errors.ts";
import { hashHrmToken, mintSurveyInvitationToken, verifySurveyInvitationToken } from "../documents/tokens.ts";
import {
  INVITATION_TTL_MS,
  loadSurveyInviteeEmployers,
  partyVisibleToScope,
  surveyVisibleToScope,
} from "./surveys.ts";
import {
  aggregateQuestion,
  computeEnps,
  driverScores,
  heatmap,
  type ResultAnswer,
} from "./results.ts";

/**
 * HR-19 survey responses and aggregate results.
 *
 * submitResponse runs through the invitation token (own session or token,
 * never a grant): it re-validates the invitation row (survey open and in
 * window, token hash match, not yet responded — a replayed token is
 * refused as already-responded, never double-counted), validates every
 * answer against its question kind, then stores by anonymity grade:
 * - anonymous: respondent_link_enc is NULL (asserted, not merely
 *   unused) and the segment snapshot is stored ONLY when the segment
 *   group at submission time holds at least min_group_size invitees.
 *   The invitation flips responded_at with no link to the response row.
 * - confidential: the party link is AES-256-GCM encrypted with the
 *   org-derived data key; results readers never decrypt (no decrypt
 *   path exists in this module — aggregates only).
 * - named: the party id is stored as plain bytes.
 *
 * Results (getSurveyResults) serve aggregates only: per-question counts,
 * eNPS, driver scores, the suppressed heatmap, the pulse trend, and the
 * group-gated comment list. Respondent links never leave this module.
 * Every aggregate — invitation counts, responses, comments, and the
 * trend — is computed over in-scope respondents only (named by decoded
 * link, confidential by decrypted link, anonymous by the employer list
 * stamped at submission), and the anonymity minimum applies AFTER
 * scoping, so a scoped slice can never de-anonymize a small group.
 */

// --- Confidential-link encryption (pure; the exact code results rely on) ---

function orgDataKey(orgId: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new HrmSurveysError("REFUSED", "SESSION_SECRET is required for confidential survey links");
  return createHmac("sha256", secret).update(`hrm-survey-link:${orgId}`).digest();
}

/** Encrypt a party link for confidential surveys (iv + ciphertext + tag). */
export function encryptRespondentLink(orgId: string, partyId: string): Buffer {
  const key = orgDataKey(orgId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(partyId, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** Decrypt a confidential link. Exists for the governed disclosure path
 * only — results readers never call it. */
export function decryptRespondentLink(orgId: string, sealed: Uint8Array): string {
  const key = orgDataKey(orgId);
  const buf = Buffer.from(sealed);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// --- Submission ---

export interface SubmitAnswer {
  questionId: string;
  value: unknown;
}

function validateAnswer(
  question: { id: string; kind: string; options: unknown },
  value: unknown,
): { numeric: number | null; raw: unknown } {
  const options = Array.isArray(question.options) ? question.options.map((o) => String(o)) : [];
  switch (question.kind) {
    case "scale": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        throw new HrmSurveysError(
          "VALIDATION",
          `question ${question.id}: scale answers are whole numbers 1 to 5`,
        );
      }
      return { numeric: n, raw: n };
    }
    case "enps": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        throw new HrmSurveysError(
          "VALIDATION",
          `question ${question.id}: eNPS answers are whole numbers 0 to 10`,
        );
      }
      return { numeric: n, raw: n };
    }
    case "single": {
      if (typeof value !== "string" || !options.includes(value)) {
        throw new HrmSurveysError(
          "VALIDATION",
          `question ${question.id}: answer must be one of ${options.join(", ") || "the declared options"}`,
        );
      }
      return { numeric: null, raw: value };
    }
    case "multi": {
      if (!Array.isArray(value) || value.length === 0) {
        throw new HrmSurveysError("VALIDATION", `question ${question.id}: choose at least one option`);
      }
      for (const v of value) {
        if (typeof v !== "string" || !options.includes(v)) {
          throw new HrmSurveysError(
            "VALIDATION",
            `question ${question.id}: every choice must be one of ${options.join(", ") || "the declared options"}`,
          );
        }
      }
      return { numeric: null, raw: [...new Set(value.map((v) => String(v)))].sort() };
    }
    case "text": {
      if (typeof value !== "string" || !value.trim()) {
        throw new HrmSurveysError("VALIDATION", `question ${question.id}: text answers cannot be blank`);
      }
      if (value.length > 2000) {
        throw new HrmSurveysError("VALIDATION", `question ${question.id}: text answers hold at most 2000 characters`);
      }
      return { numeric: null, raw: value.trim() };
    }
    default:
      throw new HrmSurveysError("VALIDATION", `question ${question.id}: unknown kind ${question.kind}`);
  }
}

interface Segment {
  key: string;
  snapshot: { department: string | null; subsidiary: string | null; location: string | null; tenureBand: string | null };
}

/** Resolve a party's current segment for heatmaps (best-effort read). */
async function resolveSegment(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
  today: string,
): Promise<Segment> {
  const row = (await exec.execute<{
    department: string | null;
    subsidiary: string | null;
    location: string | null;
    start: string | null;
  }>(sql`
    select d.name as department, s.name as subsidiary, l.name as location,
           (select min(v.effective_from)::text
              from worker_employment_versions v
              join worker_employments e on e.org_id = v.org_id and e.id = v.employment_id
             where e.org_id = ${orgId} and e.worker_party_id = ${partyId}
               and v.recorded_until is null) as start
      from worker_employments e
      left join employment_assignment_versions a
        on a.org_id = e.org_id and a.employment_id = e.id and a.is_primary
           and a.recorded_until is null
           and a.effective_from <= ${today}::date
           and (a.effective_to is null or a.effective_to > ${today}::date)
      left join departments d on d.org_id = a.org_id and d.id = a.department_id
      left join subsidiaries s on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
      left join locations l on l.org_id = a.org_id and l.id = a.location_id
     where e.org_id = ${orgId} and e.worker_party_id = ${partyId}
     order by a.effective_from desc nulls last
     limit 1
  `)).rows[0];
  const tenureBand = !row?.start
    ? null
    : (() => {
        const years = (Date.parse(today) - Date.parse(row.start!)) / (365.25 * 24 * 3_600_000);
        if (years < 1) return "0-1y";
        if (years < 3) return "1-3y";
        if (years < 5) return "3-5y";
        return "5y+";
      })();
  const snapshot = {
    department: row?.department ?? null,
    subsidiary: row?.subsidiary ?? null,
    location: row?.location ?? null,
    tenureBand,
  };
  return { key: `${snapshot.department ?? "?"}|${snapshot.subsidiary ?? "?"}|${snapshot.location ?? "?"}`, snapshot };
}

/**
 * Submit through the invitation token. One response per invitation: the
 * consumed flip and the response insert happen in one transaction, and a
 * replayed token meets responded_at and is refused.
 */
export async function submitResponse(input: {
  token: string;
  answers: SubmitAnswer[];
  today: string;
}): Promise<{ responseId: string }> {
  const claims = verifySurveyInvitationToken(input.token);
  if (!claims) {
    throw new HrmSurveysError("FORBIDDEN", "this survey link is invalid or expired — ask HR for a fresh invitation");
  }
  return withOrgTransaction(claims.orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${"hrm-survey-submit:" + claims.orgId + ":" + claims.rowId}, 0))
    `);
    const invitation = (await db.execute<{
      id: string;
      survey_id: string;
      party_id: string;
      responded_at: string | null;
    }>(sql`
      select id, survey_id, party_id, responded_at::text as responded_at
        from hrm_survey_invitations
       where token_hash = ${hashHrmToken(input.token)}
    `)).rows[0];
    if (!invitation) {
      throw new HrmSurveysError("FORBIDDEN", "this survey link is no longer available — ask HR for a fresh invitation");
    }
    if (invitation.responded_at) {
      throw new HrmSurveysError(
        "REFUSED",
        "this link already responded — one response per invitation, and re-voting is never counted twice",
      );
    }
    const survey = (await db.execute<{
      id: string;
      anonymity: string;
      status: string;
      opens_at: string | null;
      closes_at: string | null;
      min_group_size: number;
    }>(sql`
      select id, anonymity, status, opens_at::text as opens_at, closes_at::text as closes_at, min_group_size
        from hrm_surveys where org_id = ${claims.orgId} and id = ${invitation.survey_id}
    `)).rows[0];
    if (!survey || survey.status !== "open") {
      throw new HrmSurveysError("REFUSED", "this survey is not open for responses — ask HR whether it was closed");
    }
    const now = Date.now();
    if (survey.opens_at && Date.parse(survey.opens_at) > now) {
      throw new HrmSurveysError("REFUSED", "this survey has not opened yet — come back at its opening time");
    }
    if (survey.closes_at && Date.parse(survey.closes_at) < now) {
      throw new HrmSurveysError("REFUSED", "this survey has closed — responses after close are never counted");
    }
    const questions = (await db.execute<{ id: string; kind: string; options: unknown; driver_key: string | null }>(sql`
      select id, kind, options, driver_key from hrm_survey_questions
       where org_id = ${claims.orgId} and survey_id = ${survey.id}
       order by position
    `)).rows;
    if (!Array.isArray(input.answers) || input.answers.length === 0) {
      throw new HrmSurveysError("VALIDATION", "answer at least one question before submitting");
    }
    const byId = new Map(questions.map((q) => [q.id, q]));
    const stored: { questionId: string; kind: string; driverKey: string | null; value: number | null; raw: unknown }[] = [];
    for (const answer of input.answers) {
      const question = byId.get(answer.questionId);
      if (!question) {
        throw new HrmSurveysError("VALIDATION", "one answer names a question that is not on this survey");
      }
      const valid = validateAnswer(question, answer.value);
      stored.push({
        questionId: question.id,
        kind: question.kind,
        driverKey: question.driver_key,
        value: valid.numeric,
        raw: valid.raw,
      });
    }
    const segment = await resolveSegment(db, claims.orgId, invitation.party_id, input.today);
    // The respondent's employer footprint at submission time, stored
    // beside the segment names: results for subsidiary-restricted readers
    // are computed over in-scope respondents only, and anonymous rows
    // carry no link to attribute by — without this list they would be
    // unattributable. Same granularity as the subsidiary name already
    // stored; aggregates only, links never leave.
    const employerIds = (
      await db.execute<{ employerSubsidiaryId: string }>(sql`
        select distinct employer_subsidiary_id as "employerSubsidiaryId"
          from worker_employments
         where org_id = ${claims.orgId} and worker_party_id = ${invitation.party_id}
           and employer_subsidiary_id is not null
      `)
    ).rows.map((row) => row.employerSubsidiaryId);
    const snapshotWithScope = { ...segment.snapshot, employerSubsidiaryIds: employerIds };
    let segmentSnapshot: unknown = null;
    let linkEnc: Buffer | null = null;
    if (survey.anonymity === "anonymous") {
      // The segment group at submission time: invitees sharing this
      // respondent's segment. Below minimum the segment detail stays
      // suppressed — a lone segment IS an identity — but the employer
      // footprint is still stamped: without it subsidiary-restricted
      // readers could never attribute (and thus never aggregate) the
      // row. Entity ids name the entity, never the respondent.
      const peers = await countSegmentPeers(db, claims.orgId, survey.id, invitation.party_id, segment, input.today);
      segmentSnapshot =
        peers >= survey.min_group_size ? snapshotWithScope : { employerSubsidiaryIds: employerIds };
      linkEnc = null;
    } else if (survey.anonymity === "confidential") {
      segmentSnapshot = snapshotWithScope;
      linkEnc = encryptRespondentLink(claims.orgId, invitation.party_id);
    } else {
      segmentSnapshot = snapshotWithScope;
      linkEnc = Buffer.from(invitation.party_id, "utf8");
    }
    const responseId = (await db.execute<{ id: string }>(sql`
      insert into hrm_survey_responses (org_id, survey_id, respondent_link_enc, segment_snapshot, answers)
      values (${claims.orgId}, ${survey.id}, ${linkEnc}, ${segmentSnapshot ? JSON.stringify(segmentSnapshot) : null}::jsonb,
              ${JSON.stringify(stored)}::jsonb)
      returning id
    `)).rows[0]!.id;
    const flipped = (await db.execute<{ n: string }>(sql`
      update hrm_survey_invitations set responded_at = now()
       where org_id = ${claims.orgId} and id = ${invitation.id} and responded_at is null
      returning 1
    `)).rows.length;
    // Zero flipped rows is a replay that raced us: the response insert
    // above rolls back with this throw — never a counted double vote.
    if (flipped === 0) {
      throw new HrmSurveysError(
        "REFUSED",
        "this link already responded — one response per invitation, and re-voting is never counted twice",
      );
    }
    return { responseId };
  });
}

export interface OwnInvitation {
  invitationId: string;
  surveyId: string;
  surveyName: string;
  surveyKind: string;
  anonymity: string;
  closesAt: string | null;
}

async function requireSelfRead(orgId: string, actorId: string): Promise<string> {
  if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) {
    throw new HrmSurveysError(
      "REFUSED",
      "survey invitations need the employee self-service grant — ask an administrator for access in /admin/roles",
    );
  }
  const partyId = await loadActorPartyId(db, orgId, actorId);
  if (!partyId) {
    throw new HrmSurveysError(
      "REFUSED",
      "your login is not linked to a person record — ask HR to link it before opening your surveys",
    );
  }
  return partyId;
}

/** Open invitations for the actor's own party (the /me Open surveys rail). */
export async function listOwnInvitations(query: {
  orgId: string;
  actorId: string;
}): Promise<OwnInvitation[]> {
  const partyId = await requireSelfRead(query.orgId, query.actorId);
  const rows = (await db.execute<{
    invitationId: string;
    surveyId: string;
    surveyName: string;
    surveyKind: string;
    anonymity: string;
    closesAt: string | null;
  }>(sql`
    select i.id as "invitationId", s.id as "surveyId", s.name as "surveyName",
           s.kind as "surveyKind", s.anonymity as "anonymity",
           s.closes_at::text as "closesAt"
      from hrm_survey_invitations i
      join hrm_surveys s on s.org_id = i.org_id and s.id = i.survey_id
     where i.org_id = ${query.orgId} and i.party_id = ${partyId}
       and i.responded_at is null and s.status = 'open'
       and (s.closes_at is null or s.closes_at > now())
     order by s.closes_at nulls last, s.name
  `)).rows;
  return rows;
}

/**
 * Re-mint one open invitation's token for the invited party in-session:
 * the old link dies (a stale open meets the no-longer-available
 * refusal) and the fresh token returns for the /survey/[token] page.
 * Refuses answered invitations, closed surveys, and invitations
 * addressed to anyone else — this path never answers for another
 * person. Powers /me Open surveys: the respond link without email.
 */
export async function reissueInvitationToken(input: {
  orgId: string;
  actorId: string;
  invitationId: string;
}): Promise<{ token: string; surveyId: string }> {
  const partyId = await requireSelfRead(input.orgId, input.actorId);
  return withOrgTransaction(input.orgId, async () => {
    const invitation = (await db.execute<{ id: string; survey_id: string; responded_at: string | null }>(sql`
      select id, survey_id, responded_at::text as responded_at
        from hrm_survey_invitations
       where org_id = ${input.orgId} and id = ${input.invitationId} and party_id = ${partyId}
    `)).rows[0];
    // Zero rows is a failure: unknown id or another person's invitation.
    if (!invitation) {
      throw new HrmSurveysError("NOT_FOUND", "invitation is not visible to you — it may belong to someone else");
    }
    if (invitation.responded_at) {
      throw new HrmSurveysError("REFUSED", "you already answered this survey — one response per invitation");
    }
    const survey = (await db.execute<{ status: string }>(sql`
      select status from hrm_surveys where org_id = ${input.orgId} and id = ${invitation.survey_id}
    `)).rows[0];
    if (!survey || survey.status !== "open") {
      throw new HrmSurveysError("REFUSED", "this survey is not open for responses");
    }
    const token = mintSurveyInvitationToken(input.orgId, invitation.id, new Date(Date.now() + INVITATION_TTL_MS));
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_survey_invitations
         set token_hash = ${hashHrmToken(token)}
       where org_id = ${input.orgId} and id = ${invitation.id} and responded_at is null
      returning id
    `)).rows[0];
    // Zero matched rows is a race the respondent won elsewhere.
    if (!updated) {
      throw new HrmSurveysError("REFUSED", "this invitation was just answered — one response per invitation");
    }
    return { token, surveyId: invitation.survey_id };
  });
}

/** Invitees sharing the respondent's current segment (for the minimum check). */
async function countSegmentPeers(
  exec: SqlExecutor,
  orgId: string,
  surveyId: string,
  excludePartyId: string,
  segment: Segment,
  today: string,
): Promise<number> {
  const invitees = (await exec.execute<{ party_id: string }>(sql`
    select party_id from hrm_survey_invitations
     where org_id = ${orgId} and survey_id = ${surveyId} and party_id != ${excludePartyId}
  `)).rows;
  let peers = 1; // the respondent themself
  for (const invitee of invitees) {
    const other = await resolveSegment(exec, orgId, invitee.party_id, today);
    if (other.key === segment.key) peers += 1;
  }
  return peers;
}

// --- Aggregate results (HR readers only; links never leave) ---

export interface SurveyResults {
  surveyId: string;
  anonymity: string;
  status: string;
  /** True when the response slice is below the configured disclosure floor. */
  suppressed: boolean;
  invitations: number;
  responded: number;
  participationPct: number | null;
  questions: {
    id: string;
    kind: string;
    prompt: string;
    driverKey: string | null;
    aggregate: ReturnType<typeof aggregateQuestion>;
  }[];
  enps: ReturnType<typeof computeEnps> | null;
  drivers: ReturnType<typeof driverScores>;
  heat: ReturnType<typeof heatmap>;
  trend: { surveyId: string; name: string; submittedAt: string | null; enps: number | null }[];
  comments: { questionId: string; prompt: string; texts: string[] }[];
}

/**
 * One stored response is inside the reader's lens when its respondent is:
 * named rows decode the party link, confidential rows decrypt it (results
 * readers never expose the link — it only decides inclusion), and
 * anonymous rows attribute through the employer list stamped at
 * submission. Legacy anonymous rows without that list are unattributable
 * and stay out of restricted slices (fail closed); unrestricted readers
 * include everything, exactly as before.
 */
function responseInScope(
  orgId: string,
  anonymity: string,
  linkEnc: Buffer | Uint8Array | null,
  snapshot: unknown,
  employersByParty: ReadonlyMap<string, readonly string[]>,
  allowed: ReadonlySet<string> | null,
): boolean {
  if (allowed === null) return true;
  if (anonymity === "named") {
    if (!linkEnc) return false;
    const party = Buffer.from(linkEnc).toString("utf8");
    return partyVisibleToScope(employersByParty.get(party) ?? [], allowed);
  }
  if (anonymity === "confidential") {
    if (!linkEnc) return false;
    let party: string;
    try {
      party = decryptRespondentLink(orgId, linkEnc);
    } catch {
      return false;
    }
    return partyVisibleToScope(employersByParty.get(party) ?? [], allowed);
  }
  const ids = (snapshot as { employerSubsidiaryIds?: unknown } | null)?.employerSubsidiaryIds;
  return Array.isArray(ids) && ids.some((id) => typeof id === "string" && allowed.has(id));
}

export async function getSurveyResults(query: {
  orgId: string;
  actorId: string;
  surveyId: string;
}): Promise<SurveyResults> {
  const allowed = await requireHrmSurveysManage(db, query.orgId, query.actorId);
  const survey = (await db.execute<{
    id: string;
    name: string;
    kind: string;
    anonymity: string;
    status: string;
    min_group_size: number;
  }>(sql`
    select id, name, kind, anonymity, status, min_group_size from hrm_surveys
     where org_id = ${query.orgId} and id = ${query.surveyId}
  `)).rows[0];
  if (!survey) throw new HrmSurveysError("NOT_FOUND", "survey is not visible in this organization");
  // Read visibility first: a survey with no in-scope invitee reads as
  // not-found, uniformly with a missing survey.
  const employersByParty = await loadSurveyInviteeEmployers(db, query.orgId, survey.id);
  if (!surveyVisibleToScope(employersByParty, allowed)) {
    throw new HrmSurveysError("NOT_FOUND", "survey is not visible in this organization");
  }
  const questions = (await db.execute<{
    id: string;
    kind: string;
    prompt: string;
    driver_key: string | null;
  }>(sql`
    select id, kind, prompt, driver_key from hrm_survey_questions
     where org_id = ${query.orgId} and survey_id = ${survey.id}
     order by position
  `)).rows;
  // Invitation counts fence to in-scope invitees: the participation
  // denominator must never count B's respondents for an A reader.
  const invitees = (await db.execute<{ party_id: string; responded: boolean }>(sql`
    select party_id, (responded_at is not null) as responded
      from hrm_survey_invitations
     where org_id = ${query.orgId} and survey_id = ${survey.id}
  `)).rows;
  const scopedInvitees = invitees.filter((invite) =>
    partyVisibleToScope(employersByParty.get(invite.party_id) ?? [], allowed),
  );
  const invitations = scopedInvitees.length;
  const respondedCount = scopedInvitees.filter((invite) => invite.responded).length;
  const responses = (
    await db.execute<{ answers: unknown; segment_snapshot: unknown; respondent_link_enc: Buffer | null }>(sql`
    select answers, segment_snapshot, respondent_link_enc from hrm_survey_responses
     where org_id = ${query.orgId} and survey_id = ${survey.id}
  `)
  ).rows.filter((response) =>
    responseInScope(
      query.orgId,
      survey.anonymity,
      response.respondent_link_enc,
      response.segment_snapshot,
      employersByParty,
      allowed,
    ),
  );
  const suppressed = responses.length < survey.min_group_size;
  const byQuestion = new Map(questions.map((q) => [q.id, q]));
  const flat: ResultAnswer[] = [];
  for (const response of responses) {
    const answers = Array.isArray(response.answers) ? response.answers : [];
    const snapshot = (response.segment_snapshot ?? {}) as { department?: string | null };
    for (const a of answers as { questionId: string; kind: string; driverKey: string | null; value: number | null; raw: unknown }[]) {
      const q = byQuestion.get(a.questionId);
      if (!q) continue;
      flat.push({
        questionId: a.questionId,
        kind: a.kind,
        driverKey: a.driverKey,
        value: typeof a.value === "number" ? a.value : null,
        raw: a.raw,
        segment: snapshot.department ?? null,
      });
    }
  }
  const enpsQuestion = questions.find((q) => q.kind === "enps");
  const enps = enpsQuestion && !suppressed
    ? computeEnps(flat.filter((a) => a.questionId === enpsQuestion.id && a.value !== null).map((a) => a.value!))
    : null;
  // Comments surface only when the reader's scoped slice clears the
  // minimum — the threshold applies AFTER scoping, so a small scoped
  // slice can never de-anonymize a group the minimum would protect.
  // Anonymous comments carry no link by construction, and
  // named/confidential comments show as unattributed text — the reader
  // grants no path back to a respondent.
  const comments =
    !suppressed
      ? questions
          .filter((q) => q.kind === "text")
          .map((q) => ({
            questionId: q.id,
            prompt: q.prompt,
            texts: flat
              .filter((a) => a.questionId === q.id && typeof a.raw === "string")
              .map((a) => a.raw as string)
              .slice(0, 100),
          }))
          .filter((c) => c.texts.length > 0)
      : [];
  // Pulse trend: same-name surveys in series order with their eNPS. Each
  // sibling fences to the same lens — a sibling with no in-scope invitee
  // stays out of a restricted reader's trend entirely, and every
  // included sibling's score aggregates in-scope respondents only.
  const series = (await db.execute<{ id: string; name: string; anonymity: string }>(sql`
    select id, name, anonymity from hrm_surveys
     where org_id = ${query.orgId} and name = ${survey.name} and kind = ${survey.kind}
       and status in ('open', 'closed')
     order by created_at
  `)).rows;
  const trend: SurveyResults["trend"] = [];
  for (const sibling of series) {
    const sibEmployers = await loadSurveyInviteeEmployers(db, query.orgId, sibling.id);
    if (!surveyVisibleToScope(sibEmployers, allowed)) continue;
    const sibAnswers = (await db.execute<{
      answers: unknown;
      segment_snapshot: unknown;
      respondent_link_enc: Buffer | null;
    }>(sql`
      select r.answers, r.segment_snapshot, r.respondent_link_enc
        from hrm_survey_responses r
        join hrm_survey_questions q on q.org_id = r.org_id and q.survey_id = r.survey_id and q.kind = 'enps'
       where r.org_id = ${query.orgId} and r.survey_id = ${sibling.id}
       limit 5000
    `)).rows.filter((row) =>
      responseInScope(
        query.orgId,
        sibling.anonymity,
        row.respondent_link_enc,
        row.segment_snapshot,
        sibEmployers,
        allowed,
      ),
    );
    const values: number[] = [];
    const enpsQ = (await db.execute<{ id: string }>(sql`
      select id from hrm_survey_questions
       where org_id = ${query.orgId} and survey_id = ${sibling.id} and kind = 'enps'
       order by position limit 1
    `)).rows[0];
    if (enpsQ) {
      for (const row of sibAnswers) {
        const list = Array.isArray(row.answers) ? row.answers : [];
        for (const a of list as { questionId: string; value: unknown }[]) {
          if (a.questionId === enpsQ.id && typeof a.value === "number") values.push(a.value);
        }
      }
    }
    trend.push({
      surveyId: sibling.id,
      name: sibling.name,
      submittedAt: null,
      enps: enpsQ && values.length >= survey.min_group_size ? computeEnps(values).score : null,
    });
  }
  const responded = respondedCount;
  return {
    surveyId: survey.id,
    anonymity: survey.anonymity,
    status: survey.status,
    suppressed,
    invitations: suppressed ? 0 : invitations,
    responded: suppressed ? 0 : responded,
    participationPct: suppressed || invitations === 0 ? null : Math.round((responded / invitations) * 1000) / 10,
    questions: questions.map((q) => ({
      id: q.id,
      kind: q.kind,
      prompt: q.prompt,
      driverKey: q.driver_key,
      aggregate: suppressed
        ? { questionId: q.id, kind: q.kind, responses: 0, mean: null, distribution: [] }
        : aggregateQuestion(q.id, q.kind, flat.filter((a) => a.questionId === q.id)),
    })),
    enps,
    drivers: suppressed ? [] : driverScores(flat),
    heat: suppressed ? { drivers: [], segments: [], cells: {} } : heatmap(flat, survey.min_group_size),
    trend,
    comments,
  };
}
