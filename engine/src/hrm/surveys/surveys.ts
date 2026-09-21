import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { requireHrmSurveysManage } from "../authorization.ts";
import { HrmSurveysError } from "../documents/errors.ts";
import { hashHrmToken, mintSurveyInvitationToken } from "../documents/tokens.ts";

/**
 * HR-19 survey authoring and lifecycle.
 *
 * Surveys are authored draft (questions as ordered cards), then opened:
 * open() creates one tokened invitation per respondent party and returns
 * the delivery intents — the API route performs email/notification
 * delivery web-side. close() freezes a survey; closed surveys take no
 * responses and their results stay readable. Audience is stored as the
 * applies_to shape; invitation parties are resolved by the caller (the
 * route offers the org's active-employment roster) and validated here
 * for org membership — an invitation to a foreign party is refused.
 */

export const HRM_SURVEYS_FEATURE_KEY = "hrmSurveys";

export const SURVEY_KINDS = ["engagement", "pulse", "onboarding", "exit", "custom"] as const;
export const SURVEY_ANONYMITY = ["anonymous", "confidential", "named"] as const;
export const QUESTION_KINDS = ["scale", "enps", "text", "single", "multi"] as const;

async function assertSurveysFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmSurveysError(
      "REFUSED",
      "surveys are unavailable while the hrm feature is off — enable it under Company Settings → Features; existing surveys are preserved",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_SURVEYS_FEATURE_KEY))) {
    throw new HrmSurveysError(
      "REFUSED",
      "surveys are unavailable while the hrmSurveys feature is off — enable it under Company Settings → Features; existing surveys are preserved",
    );
  }
}

export interface SurveyQuestionDTO {
  id: string;
  position: number;
  kind: string;
  prompt: string;
  options: unknown;
  driverKey: string | null;
}

export interface SurveyDTO {
  id: string;
  name: string;
  kind: string;
  anonymity: string;
  status: string;
  opensAt: string | null;
  closesAt: string | null;
  audience: unknown;
  recurrence: unknown;
  minGroupSize: number;
  questions: SurveyQuestionDTO[];
}

type SurveyRow = {
  id: string;
  name: string;
  kind: string;
  anonymity: string;
  status: string;
  opens_at: string | null;
  closes_at: string | null;
  audience: unknown;
  recurrence: unknown;
  min_group_size: number;
};

const SURVEY_COLS = sql`
  select id, name, kind, anonymity, status,
         opens_at::text as opens_at, closes_at::text as closes_at,
         audience, recurrence, min_group_size
    from hrm_surveys`;

async function loadQuestions(
  exec: SqlExecutor,
  orgId: string,
  surveyId: string,
): Promise<SurveyQuestionDTO[]> {
  const rows = (await exec.execute<{
    id: string;
    position: number;
    kind: string;
    prompt: string;
    options: unknown;
    driver_key: string | null;
  }>(sql`
    select id, position, kind, prompt, options, driver_key
      from hrm_survey_questions
     where org_id = ${orgId} and survey_id = ${surveyId}
     order by position
  `)).rows;
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    kind: r.kind,
    prompt: r.prompt,
    options: r.options,
    driverKey: r.driver_key,
  }));
}

async function toDTO(exec: SqlExecutor, orgId: string, row: SurveyRow): Promise<SurveyDTO> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    anonymity: row.anonymity,
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    audience: row.audience,
    recurrence: row.recurrence,
    minGroupSize: row.min_group_size,
    questions: await loadQuestions(exec, orgId, row.id),
  };
}

async function loadSurvey(exec: SqlExecutor, orgId: string, surveyId: string): Promise<SurveyRow> {
  const row = (await exec.execute<SurveyRow>(sql`
    ${SURVEY_COLS} where org_id = ${orgId} and id = ${surveyId}
  `)).rows[0];
  if (!row) throw new HrmSurveysError("NOT_FOUND", "survey is not visible in this organization");
  return row;
}

export interface QuestionInput {
  kind: unknown;
  prompt: unknown;
  options?: unknown;
  driverKey?: unknown;
}

function validateQuestions(questions: unknown): {
  kind: string;
  prompt: string;
  options: unknown[];
  driverKey: string | null;
}[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new HrmSurveysError("VALIDATION", "a survey needs at least one question card");
  }
  if (questions.length > 100) {
    throw new HrmSurveysError("VALIDATION", "a survey holds at most 100 questions");
  }
  return (questions as QuestionInput[]).map((q, i) => {
    if (!QUESTION_KINDS.includes(q.kind as (typeof QUESTION_KINDS)[number])) {
      throw new HrmSurveysError(
        "VALIDATION",
        `question ${i + 1}: kind must be scale, enps, text, single, or multi`,
      );
    }
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) throw new HrmSurveysError("VALIDATION", `question ${i + 1}: prompt is required`);
    const options = Array.isArray(q.options) ? q.options.map((o) => String(o)) : [];
    if ((q.kind === "single" || q.kind === "multi") && options.length < 2) {
      throw new HrmSurveysError(
        "VALIDATION",
        `question ${i + 1}: choice questions need at least two options`,
      );
    }
    const driverKey =
      typeof q.driverKey === "string" && q.driverKey.trim() ? q.driverKey.trim() : null;
    if (driverKey && q.kind !== "scale") {
      throw new HrmSurveysError(
        "VALIDATION",
        `question ${i + 1}: driver keys group scale questions for heatmaps — choice, text and eNPS questions carry none`,
      );
    }
    return { kind: String(q.kind), prompt, options, driverKey };
  });
}

export async function listSurveys(query: {
  orgId: string;
  actorId: string;
  status?: string;
}): Promise<SurveyDTO[]> {
  await requireHrmSurveysManage(db, query.orgId, query.actorId);
  const rows = (await db.execute<SurveyRow>(sql`
    ${SURVEY_COLS}
     where org_id = ${query.orgId}
       ${query.status ? sql`and status = ${query.status}` : sql``}
     order by created_at desc
  `)).rows;
  return Promise.all(rows.map((r) => toDTO(db, query.orgId, r)));
}

export async function getSurvey(query: {
  orgId: string;
  actorId: string;
  surveyId: string;
}): Promise<SurveyDTO> {
  await requireHrmSurveysManage(db, query.orgId, query.actorId);
  return toDTO(db, query.orgId, await loadSurvey(db, query.orgId, query.surveyId));
}

export async function saveSurvey(input: {
  orgId: string;
  actorId: string;
  surveyId?: string;
  name: unknown;
  kind: unknown;
  anonymity: unknown;
  opensAt?: string | null;
  closesAt?: string | null;
  audience?: unknown;
  recurrence?: unknown;
  minGroupSize?: unknown;
  questions: unknown;
}): Promise<SurveyDTO> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new HrmSurveysError("VALIDATION", "survey name is required");
  if (!SURVEY_KINDS.includes(input.kind as (typeof SURVEY_KINDS)[number])) {
    throw new HrmSurveysError("VALIDATION", "kind must be engagement, pulse, onboarding, exit, or custom");
  }
  if (!SURVEY_ANONYMITY.includes(input.anonymity as (typeof SURVEY_ANONYMITY)[number])) {
    throw new HrmSurveysError("VALIDATION", "anonymity must be anonymous, confidential, or named");
  }
  const minGroupSize = input.minGroupSize === undefined ? 5 : Number(input.minGroupSize);
  if (!Number.isInteger(minGroupSize) || minGroupSize < 2) {
    throw new HrmSurveysError(
      "VALIDATION",
      "minGroupSize must be at least 2 — a group of one is never anonymous, so the floor is refused, not rounded",
    );
  }
  const questions = validateQuestions(input.questions);
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmSurveysManage(db, input.orgId, input.actorId);
    await assertSurveysFeature(db, input.orgId);
    let surveyId = input.surveyId ?? null;
    if (surveyId) {
      const existing = await loadSurvey(db, input.orgId, surveyId);
      if (existing.status !== "draft") {
        throw new HrmSurveysError(
          "REFUSED",
          `an open or closed survey is history — copy it to a new survey instead of editing the ${existing.status} one`,
        );
      }
      const updated = (await db.execute<SurveyRow>(sql`
        update hrm_surveys
           set name = ${name}, kind = ${input.kind}, anonymity = ${input.anonymity},
               opens_at = ${input.opensAt ?? null}, closes_at = ${input.closesAt ?? null},
               audience = ${JSON.stringify(input.audience ?? {})}::jsonb,
               recurrence = ${input.recurrence ? JSON.stringify(input.recurrence) : null}::jsonb,
               min_group_size = ${minGroupSize},
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${surveyId}
        returning id, name, kind, anonymity, status,
                  opens_at::text as opens_at, closes_at::text as closes_at,
                  audience, recurrence, min_group_size
      `)).rows[0];
      if (!updated) throw new HrmSurveysError("NOT_FOUND", "survey is not visible in this organization");
      await db.execute(sql`
        delete from hrm_survey_questions where org_id = ${input.orgId} and survey_id = ${surveyId}
      `);
    } else {
      const inserted = (await db.execute<SurveyRow>(sql`
        insert into hrm_surveys
          (org_id, name, kind, anonymity, opens_at, closes_at, audience, recurrence,
           min_group_size, created_by, updated_by)
        values (${input.orgId}, ${name}, ${input.kind}, ${input.anonymity},
                ${input.opensAt ?? null}, ${input.closesAt ?? null},
                ${JSON.stringify(input.audience ?? {})}::jsonb,
                ${input.recurrence ? JSON.stringify(input.recurrence) : null}::jsonb,
                ${minGroupSize}, ${input.actorId}, ${input.actorId})
        returning id, name, kind, anonymity, status,
                  opens_at::text as opens_at, closes_at::text as closes_at,
                  audience, recurrence, min_group_size
      `)).rows[0];
      if (!inserted) {
        throw new HrmSurveysError(
          "REFUSED",
          "the survey insert matched no row — the save is refused, never a silent success",
        );
      }
      surveyId = inserted.id;
    }
    let position = 0;
    for (const q of questions) {
      await db.execute(sql`
        insert into hrm_survey_questions
          (org_id, survey_id, position, kind, prompt, options, driver_key, created_by, updated_by)
        values (${input.orgId}, ${surveyId}, ${position}, ${q.kind}, ${q.prompt},
                ${JSON.stringify(q.options)}::jsonb, ${q.driverKey},
                ${input.actorId}, ${input.actorId})
      `);
      position += 1;
    }
    return toDTO(db, input.orgId, await loadSurvey(db, input.orgId, surveyId));
  });
}

export interface SurveyDeliveryIntent {
  invitationId: string;
  partyId: string;
  email: string | null;
  userId: string | null;
  token: string;
}

export const INVITATION_TTL_MS = 60 * 24 * 3_600_000; // 60 days

/**
 * Open a draft survey: create one tokened invitation per respondent.
 * Party ids are validated for org membership; duplicates collapse to one
 * invitation per party. Returns delivery intents for route-side sending.
 */
export async function openSurvey(input: {
  orgId: string;
  actorId: string;
  surveyId: string;
  partyIds: string[];
}): Promise<{ survey: SurveyDTO; deliveries: SurveyDeliveryIntent[] }> {
  if (!Array.isArray(input.partyIds) || input.partyIds.length === 0) {
    throw new HrmSurveysError(
      "VALIDATION",
      "opening needs respondents — pass the invited parties (the route offers the active-employment roster)",
    );
  }
  const unique = [...new Set(input.partyIds)];
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmSurveysManage(db, input.orgId, input.actorId);
    await assertSurveysFeature(db, input.orgId);
    const survey = await loadSurvey(db, input.orgId, input.surveyId);
    if (survey.status !== "draft") {
      throw new HrmSurveysError("REFUSED", `only draft surveys open — this one is ${survey.status}`);
    }
    const questions = await loadQuestions(db, input.orgId, survey.id);
    if (questions.length === 0) {
      throw new HrmSurveysError("VALIDATION", "a survey with no questions cannot open — author its cards first");
    }
    // Bare arrays interpolate as row constructors, not Postgres arrays
    // (the ANY() binding rule) — expand an explicit IN list instead.
    const members = (await db.execute<{ id: string }>(sql`
      select id from parties
       where org_id = ${input.orgId}
         and id in (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
    `)).rows.map((r) => r.id);
    const foreign = unique.filter((id) => !members.includes(id));
    if (foreign.length > 0) {
      throw new HrmSurveysError(
        "REFUSED",
        `${foreign.length} invited ${foreign.length === 1 ? "party is" : "parties are"} not in this organization — invitations never cross orgs`,
      );
    }
    const deliveries: SurveyDeliveryIntent[] = [];
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    for (const partyId of unique) {
      const token = mintSurveyInvitationToken(input.orgId, `${survey.id}:${partyId}`, expiresAt);
      // One invitation per (survey, party): a re-open converges instead
      // of double-inviting. The arbiter is named explicitly
      // (hrm_survey_invitations_survey_party), so only the intended
      // duplicate converges — a token collision still fails loudly.
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_survey_invitations (org_id, survey_id, party_id, token_hash)
        values (${input.orgId}, ${survey.id}, ${partyId}, ${hashHrmToken(token)})
        on conflict (org_id, survey_id, party_id) do nothing
        returning id
      `)).rows[0];
      if (!inserted) continue;
      const user = (await db.execute<{ id: string; email: string }>(sql`
        select id, email from users where org_id = ${input.orgId} and party_id = ${partyId} limit 1
      `)).rows[0];
      const person = (await db.execute<{ email: string | null }>(sql`
        select email from parties where org_id = ${input.orgId} and id = ${partyId}
      `)).rows[0];
      deliveries.push({
        invitationId: inserted.id,
        partyId,
        email: user?.email ?? person?.email ?? null,
        userId: user?.id ?? null,
        token,
      });
    }
    // No invitations at all is a failure, not an empty open.
    if (deliveries.length === 0) {
      throw new HrmSurveysError(
        "REFUSED",
        "every invited party already holds an invitation — the survey is already open to this audience",
      );
    }
    await db.execute(sql`
      update hrm_surveys set status = 'open', opens_at = coalesce(opens_at, now()),
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${survey.id}
    `);
    return { survey: await toDTO(db, input.orgId, await loadSurvey(db, input.orgId, survey.id)), deliveries };
  });
}

/**
 * Close an open survey. Closed surveys take no responses; results stay
 * readable. Re-closing is refused (the close is the evidence).
 */
export async function closeSurvey(input: {
  orgId: string;
  actorId: string;
  surveyId: string;
}): Promise<SurveyDTO> {
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmSurveysManage(db, input.orgId, input.actorId);
    await assertSurveysFeature(db, input.orgId);
    const survey = await loadSurvey(db, input.orgId, input.surveyId);
    if (survey.status !== "open") {
      throw new HrmSurveysError("REFUSED", `only open surveys close — this one is ${survey.status}`);
    }
    await db.execute(sql`
      update hrm_surveys set status = 'closed', closes_at = coalesce(closes_at, now()),
             updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${survey.id}
    `);
    return toDTO(db, input.orgId, await loadSurvey(db, input.orgId, survey.id));
  });
}
