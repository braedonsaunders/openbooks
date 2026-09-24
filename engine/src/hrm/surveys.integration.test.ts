import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { HrmSurveysError } from "./documents/errors.ts";
import { closeSurvey, getSurvey, openSurvey, saveSurvey } from "./surveys/surveys.ts";
import { getSurveyResults, submitResponse } from "./surveys/responses.ts";

/**
 * HR-19 surveys DB coverage (integration partition): anonymous responses
 * store no link (column asserted null), heatmap suppression at
 * min_group_size − 1, eNPS arithmetic through the service, confidential
 * links sealed, token replay and closed-survey refusals, and the manage
 * gate on results. Proofs are read back from storage.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = ["hrm", "hrmSurveys", "hrmPulseSurveys"];

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

type Harness = { org: ScratchOrg; hrId: string; parties: string[] };

async function setupHarness(partyCount: number): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  const hrId = await createScratchUser(org.orgId, "HR Admin", "hr_admin");
  await grantPermissions(org.orgId, hrId, ["hrm.surveys.manage"]);
  const parties: string[] = [];
  for (let i = 0; i < partyCount; i++) {
    const partyId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, email, is_active, custom)
      values (${partyId}, ${org.orgId}, 'person', ${`Respondent ${i}`}, ${`resp${i}@scratch.test`}, true, '{}'::jsonb)
    `);
    parties.push(partyId);
  }
  return { org, hrId, parties };
}

async function withHarness(count: number, fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness(count);
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

const QUESTIONS = [
  { kind: "scale", prompt: "I grow here", options: [], driverKey: "growth" },
  { kind: "enps", prompt: "Recommend us", options: [] },
  { kind: "text", prompt: "Say more", options: [] },
];

async function makeSurvey(h: Harness, anonymity: string, minGroupSize: number) {
  return saveSurvey({
    orgId: h.org.orgId,
    actorId: h.hrId,
    name: `Engagement ${randomUUID().slice(0, 8)}`,
    kind: "engagement",
    anonymity,
    minGroupSize,
    questions: QUESTIONS,
  });
}

test("anonymous responses store no link and results aggregate", { skip: !DB }, async () => {
  await withHarness(2, async (h: Harness) => {
    const survey = await makeSurvey(h, "anonymous", 2);
    const opened = await openSurvey({
      orgId: h.org.orgId,
      actorId: h.hrId,
      surveyId: survey.id,
      partyIds: h.parties,
    });
    assert.equal(opened.deliveries.length, 2);
    const fetched = await getSurvey({ orgId: h.org.orgId, actorId: h.hrId, surveyId: survey.id });
    assert.equal(fetched.status, "open");
    const questions = fetched.questions;
    const scaleId = questions.find((q) => q.kind === "scale")!.id;
    const enpsId = questions.find((q) => q.kind === "enps")!.id;
    const textId = questions.find((q) => q.kind === "text")!.id;
    const [tokenA, tokenB] = opened.deliveries.map((d) => d.token);
    await submitResponse({
      token: tokenA!,
      today: "2026-09-21",
      answers: [
        { questionId: scaleId, value: 5 },
        { questionId: enpsId, value: 10 },
        { questionId: textId, value: "Great place" },
      ],
    });
    await submitResponse({
      token: tokenB!,
      today: "2026-09-21",
      answers: [
        { questionId: scaleId, value: 3 },
        { questionId: enpsId, value: 6 },
        { questionId: textId, value: "Okay place" },
      ],
    });
    // The anonymity guarantee is the COLUMN, asserted null for every row.
    const links = (await db.execute<{ respondent_link_enc: Buffer | null; segment_snapshot: unknown }>(sql`
      select respondent_link_enc, segment_snapshot from hrm_survey_responses
       where org_id = ${h.org.orgId} and survey_id = ${survey.id}
    `)).rows;
    assert.equal(links.length, 2);
    for (const row of links) {
      assert.equal(row.respondent_link_enc, null);
    }
    // Token replay is refused, never double-counted.
    await assert.rejects(
      submitResponse({ token: tokenA!, today: "2026-09-21", answers: [{ questionId: scaleId, value: 1 }] }),
      (e: unknown) => e instanceof HrmSurveysError && /already responded/.test(e.message),
    );
    const results = await getSurveyResults({ orgId: h.org.orgId, actorId: h.hrId, surveyId: survey.id });
    assert.equal(results.responded, 2);
    assert.equal(results.participationPct, 100);
    // eNPS through the service: promoters 10, detractors 6 → 50 − 50 = 0.
    assert.equal(results.enps!.score, 0);
    assert.equal(results.drivers[0]!.mean, 4);
    assert.equal(results.comments.length, 1);
    assert.equal(results.comments[0]!.texts.length, 2);
  });
});

test("heatmap suppresses below min_group_size and comments hide", { skip: !DB }, async () => {
  await withHarness(2, async (h: Harness) => {
    // min_group_size 3 with 2 respondents: min − 1 everywhere.
    const survey = await makeSurvey(h, "anonymous", 3);
    const opened = await openSurvey({
      orgId: h.org.orgId,
      actorId: h.hrId,
      surveyId: survey.id,
      partyIds: h.parties,
    });
    const scaleId = survey.questions.find((q) => q.kind === "scale")!.id;
    for (const delivery of opened.deliveries) {
      await submitResponse({
        token: delivery.token,
        today: "2026-09-21",
        answers: [{ questionId: scaleId, value: 4 }],
      });
    }
    const results = await getSurveyResults({ orgId: h.org.orgId, actorId: h.hrId, surveyId: survey.id });
    assert.equal(results.suppressed, true);
    assert.equal(results.invitations, 0);
    assert.equal(results.responded, 0);
    assert.equal(results.participationPct, null);
    assert.equal(results.enps, null);
    assert.ok(results.questions.every((question) =>
      question.aggregate.responses === 0 && question.aggregate.mean === null && question.aggregate.distribution.length === 0,
    ));
    assert.deepEqual(results.drivers, []);
    assert.deepEqual(results.heat, { drivers: [], segments: [], cells: {} });
    assert.equal(results.comments.length, 0);
  });
});

test("confidential links are sealed and named links are plain", { skip: !DB }, async () => {
  await withHarness(1, async (h: Harness) => {
    const confidential = await makeSurvey(h, "confidential", 2);
    const opened = await openSurvey({
      orgId: h.org.orgId,
      actorId: h.hrId,
      surveyId: confidential.id,
      partyIds: [h.parties[0]!],
    });
    const scaleId = confidential.questions.find((q) => q.kind === "scale")!.id;
    await submitResponse({
      token: opened.deliveries[0]!.token,
      today: "2026-09-21",
      answers: [{ questionId: scaleId, value: 2 }],
    });
    const sealed = (await db.execute<{ respondent_link_enc: Buffer | null }>(sql`
      select respondent_link_enc from hrm_survey_responses
       where org_id = ${h.org.orgId} and survey_id = ${confidential.id}
    `)).rows[0]!.respondent_link_enc;
    assert.ok(sealed);
    assert.ok(!Buffer.from(sealed).toString("utf8").includes(h.parties[0]!));

    const named = await makeSurvey(h, "named", 2);
    const openedNamed = await openSurvey({
      orgId: h.org.orgId,
      actorId: h.hrId,
      surveyId: named.id,
      partyIds: [h.parties[0]!],
    });
    const namedScale = named.questions.find((q) => q.kind === "scale")!.id;
    await submitResponse({
      token: openedNamed.deliveries[0]!.token,
      today: "2026-09-21",
      answers: [{ questionId: namedScale, value: 5 }],
    });
    const plain = (await db.execute<{ respondent_link_enc: Buffer | null }>(sql`
      select respondent_link_enc from hrm_survey_responses
       where org_id = ${h.org.orgId} and survey_id = ${named.id}
    `)).rows[0]!.respondent_link_enc;
    assert.equal(Buffer.from(plain!).toString("utf8"), h.parties[0]!);
  });
});

test("survey lifecycle and answer refusals fire by name", { skip: !DB }, async () => {
  await withHarness(2, async (h: Harness) => {
    const survey = await makeSurvey(h, "anonymous", 2);
    // Editing the draft works; opening to a foreign party is refused.
    const edited = await saveSurvey({
      orgId: h.org.orgId,
      actorId: h.hrId,
      surveyId: survey.id,
      name: survey.name,
      kind: "engagement",
      anonymity: "anonymous",
      minGroupSize: 2,
      questions: QUESTIONS,
    });
    assert.equal(edited.status, "draft");
    await assert.rejects(
      openSurvey({ orgId: h.org.orgId, actorId: h.hrId, surveyId: survey.id, partyIds: [randomUUID()] }),
      (e: unknown) => e instanceof HrmSurveysError && /not in this organization/.test(e.message),
    );
    const opened = await openSurvey({
      orgId: h.org.orgId,
      actorId: h.hrId,
      surveyId: survey.id,
      partyIds: [h.parties[0]!],
    });
    // An opened survey is history: no edits, no second open to new parties
    // without going through open again (which converges on duplicates).
    await assert.rejects(
      saveSurvey({
        orgId: h.org.orgId,
        actorId: h.hrId,
        surveyId: survey.id,
        name: survey.name,
        kind: "engagement",
        anonymity: "anonymous",
        minGroupSize: 2,
        questions: QUESTIONS,
      }),
      (e: unknown) => e instanceof HrmSurveysError && /history/.test(e.message),
    );
    // The draft edit above re-issues question ids (delete + re-insert),
    // so answer against the fresh cards, not the stale save.
    const scaleId = edited.questions.find((q) => q.kind === "scale")!.id;
    // Answer validation names the question and the rule.
    await assert.rejects(
      submitResponse({
        token: opened.deliveries[0]!.token,
        today: "2026-09-21",
        answers: [{ questionId: scaleId, value: 9 }],
      }),
      (e: unknown) => e instanceof HrmSurveysError && /1 to 5/.test(e.message),
    );
    await assert.rejects(
      submitResponse({
        token: opened.deliveries[0]!.token,
        today: "2026-09-21",
        answers: [{ questionId: randomUUID(), value: 3 }],
      }),
      (e: unknown) => e instanceof HrmSurveysError && /not on this survey/.test(e.message),
    );
    // Closing freezes the survey: submit and re-close both refused.
    const closed = await closeSurvey({ orgId: h.org.orgId, actorId: h.hrId, surveyId: survey.id });
    assert.equal(closed.status, "closed");
    await assert.rejects(
      submitResponse({
        token: opened.deliveries[0]!.token,
        today: "2026-09-21",
        answers: [{ questionId: scaleId, value: 3 }],
      }),
      (e: unknown) => e instanceof HrmSurveysError && /not open/.test(e.message),
    );
    await assert.rejects(
      closeSurvey({ orgId: h.org.orgId, actorId: h.hrId, surveyId: survey.id }),
      (e: unknown) => e instanceof HrmSurveysError && /only open surveys close/.test(e.message),
    );
    // Results need the manage grant.
    const outsider = await createScratchUser(h.org.orgId, "Outsider", "outsider_self");
    await assert.rejects(
      getSurveyResults({ orgId: h.org.orgId, actorId: outsider, surveyId: survey.id }),
      (e: unknown) => e instanceof HrmAuthorizationError,
    );
  });
});
