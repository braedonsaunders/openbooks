import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { HrmSurveysError } from "./documents/errors.ts";
import { listSurveys, getSurvey, openSurvey, saveSurvey, closeSurvey } from "./surveys/surveys.ts";
import { getSurveyResults, submitResponse } from "./surveys/responses.ts";

/**
 * H-SURVEYS regression: survey reads and writes ignored the actor's
 * subsidiary lens. hrm.surveys.manage alone read every same-org
 * invitation count and response aggregate — a survey spanning entities
 * exposed B's respondents' scores and TEXT COMMENTS to an A-restricted
 * manager — and the create/list routes were org-only.
 *
 * Results are now computed over in-scope respondents only (named by
 * decoded link, confidential by decrypted link, anonymous by the
 * employer list stamped at submission), with invitation counts fenced
 * the same way and the anonymity minimum applied AFTER scoping, so a
 * small scoped slice can never de-anonymize a group. Opening refuses
 * out-of-scope invitees like foreign parties; edits and closes need
 * every attached respondent in scope; list/get show the scoped slice of
 * visible surveys only. Proofs are read back through the service.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of ["hrm", "hrmSurveys"]) {
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

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function seedRespondent(orgId: string, subsidiaryId: string, name: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, ${`${partyId.slice(0, 8)}@scratch.test`}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  return partyId;
}

const QUESTIONS = [
  { kind: "scale", prompt: "I grow here", options: [], driverKey: "growth" },
  { kind: "enps", prompt: "Recommend us", options: [] },
  { kind: "text", prompt: "Say more", options: [] },
];

async function answerAll(
  tokens: string[],
  questions: { id: string; kind: string }[],
  values: { scale: number; enps: number; text: string }[],
): Promise<void> {
  const scaleId = questions.find((q) => q.kind === "scale")!.id;
  const enpsId = questions.find((q) => q.kind === "enps")!.id;
  const textId = questions.find((q) => q.kind === "text")!.id;
  for (let i = 0; i < tokens.length; i++) {
    const v = values[i]!;
    await submitResponse({
      token: tokens[i]!,
      today: "2026-09-21",
      answers: [
        { questionId: scaleId, value: v.scale },
        { questionId: enpsId, value: v.enps },
        { questionId: textId, value: v.text },
      ],
    });
  }
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof HrmSurveysError, `expected HrmSurveysError, got ${String(e)}`);
    return { code: e.code, message: e.message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("H-SURVEYS: results aggregate in-scope respondents only, threshold after scoping", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFeatures(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Survey Admin", "survey_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.surveys.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const partyA1 = await seedRespondent(org.orgId, org.subsidiaryId, "Respondent A1");
    const partyA2 = await seedRespondent(org.orgId, org.subsidiaryId, "Respondent A2");
    const partyB1 = await seedRespondent(org.orgId, subB, "Respondent B1");
    const managerA = await createScratchUser(org.orgId, "Survey Manager A", "survey_mgr_a");
    await scopeRole(org.orgId, "survey_mgr_a", ["hrm.surveys.manage"], [org.subsidiaryId]);

    const draft = await saveSurvey({
      orgId: org.orgId, actorId: adminId, name: `Engagement ${randomUUID().slice(0, 8)}`,
      kind: "engagement", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
    });
    const opened = await openSurvey({
      orgId: org.orgId, actorId: adminId, surveyId: draft.id, partyIds: [partyA1, partyA2, partyB1],
    });
    assert.equal(opened.deliveries.length, 3);
    const byParty = new Map(opened.deliveries.map((d) => [d.partyId, d.token]));
    const fetched = await getSurvey({ orgId: org.orgId, actorId: adminId, surveyId: draft.id });
    await answerAll(
      [byParty.get(partyA1)!, byParty.get(partyA2)!, byParty.get(partyB1)!],
      fetched.questions,
      [
        { scale: 5, enps: 10, text: "A1 says great" },
        { scale: 5, enps: 10, text: "A2 says great" },
        { scale: 1, enps: 0, text: "B1 says terrible" },
      ],
    );

    // Unrestricted: the whole survey — three invitees, three responses,
    // B's comment included, eNPS over all three (67 − 33 = 34).
    const full = await getSurveyResults({ orgId: org.orgId, actorId: adminId, surveyId: draft.id });
    assert.equal(full.invitations, 3);
    assert.equal(full.responded, 3);
    assert.equal(full.enps?.responses, 3);
    assert.equal(full.enps?.score, 34);
    assert.ok(full.comments[0]!.texts.some((t) => t.includes("terrible")), "admin sees every comment");

    // A-scoped: two invitees, two responses, eNPS 100 over the A slice —
    // B's scores and TEXT COMMENTS never reach the restricted reader.
    const scoped = await getSurveyResults({ orgId: org.orgId, actorId: managerA, surveyId: draft.id });
    assert.equal(scoped.invitations, 2);
    assert.equal(scoped.responded, 2);
    assert.equal(scoped.participationPct, 100);
    assert.equal(scoped.enps?.responses, 2);
    assert.equal(scoped.enps?.score, 100);
    assert.ok(scoped.comments[0]!.texts.some((t) => t.includes("great")));
    assert.ok(!scoped.comments.flatMap((c) => c.texts).some((t) => t.includes("terrible")), "B's comment stays hidden");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-SURVEYS: the anonymity minimum applies after scoping", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFeatures(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Survey Admin", "survey2_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.surveys.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const partyA1 = await seedRespondent(org.orgId, org.subsidiaryId, "Respondent A1");
    const partyB1 = await seedRespondent(org.orgId, subB, "Respondent B1");
    const managerA = await createScratchUser(org.orgId, "Survey Manager A", "survey2_mgr_a");
    await scopeRole(org.orgId, "survey2_mgr_a", ["hrm.surveys.manage"], [org.subsidiaryId]);

    // min_group_size 3 with one A and one B respondent: the whole survey
    // clears nothing, but the scoped slice of one must clear even less.
    const draft = await saveSurvey({
      orgId: org.orgId, actorId: adminId, name: `Pulse ${randomUUID().slice(0, 8)}`,
      kind: "pulse", anonymity: "anonymous", minGroupSize: 2, questions: QUESTIONS,
    });
    const opened = await openSurvey({
      orgId: org.orgId, actorId: adminId, surveyId: draft.id, partyIds: [partyA1, partyB1],
    });
    const byParty = new Map(opened.deliveries.map((d) => [d.partyId, d.token]));
    const fetched = await getSurvey({ orgId: org.orgId, actorId: adminId, surveyId: draft.id });
    await answerAll(
      [byParty.get(partyA1)!, byParty.get(partyB1)!],
      fetched.questions,
      [
        { scale: 4, enps: 9, text: "A1 anonymous note" },
        { scale: 2, enps: 3, text: "B1 anonymous note" },
      ],
    );

    // Admin: two responses clear the minimum — both comments show.
    const full = await getSurveyResults({ orgId: org.orgId, actorId: adminId, surveyId: draft.id });
    assert.equal(full.responded, 2);
    assert.equal(full.comments[0]!.texts.length, 2);

    // A-scoped: one in-scope response clears nothing — no comments, and
    // the lone A response is the only aggregate input.
    const scoped = await getSurveyResults({ orgId: org.orgId, actorId: managerA, surveyId: draft.id });
    assert.equal(scoped.invitations, 1);
    assert.equal(scoped.responded, 1);
    assert.equal(scoped.comments.length, 0, "a scoped slice of one de-anonymizes nobody");
    assert.equal(scoped.enps?.responses, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-SURVEYS: confidential responses attribute through the sealed link", { skip: !DB }, async () => {
  // The sealed link never leaves, but it decides inclusion: the
  // confidential slice for A holds A's response only.
  const priorSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "openbooks-test-only-survey-scope";
  try {
    const org = await createScratchOrg();
    try {
      await enableFeatures(org.orgId);
      const adminId = await createScratchUser(org.orgId, "Survey Admin", "survey4_admin");
      await grantPermissions(org.orgId, adminId, ["hrm.surveys.manage"]);
      const subB = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
          from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
      const partyA1 = await seedRespondent(org.orgId, org.subsidiaryId, "Respondent A1");
      const partyB1 = await seedRespondent(org.orgId, subB, "Respondent B1");
      const managerA = await createScratchUser(org.orgId, "Survey Manager A", "survey4_mgr_a");
      await scopeRole(org.orgId, "survey4_mgr_a", ["hrm.surveys.manage"], [org.subsidiaryId]);
      const draft = await saveSurvey({
        orgId: org.orgId, actorId: adminId, name: `Custom ${randomUUID().slice(0, 8)}`,
        kind: "custom", anonymity: "confidential", minGroupSize: 2, questions: QUESTIONS,
      });
      const opened = await openSurvey({
        orgId: org.orgId, actorId: adminId, surveyId: draft.id, partyIds: [partyA1, partyB1],
      });
      const byParty = new Map(opened.deliveries.map((d) => [d.partyId, d.token]));
      const fetched = await getSurvey({ orgId: org.orgId, actorId: adminId, surveyId: draft.id });
      await answerAll(
        [byParty.get(partyA1)!, byParty.get(partyB1)!],
        fetched.questions,
        [
          { scale: 5, enps: 10, text: "A1 sealed note" },
          { scale: 1, enps: 0, text: "B1 sealed note" },
        ],
      );
      const full = await getSurveyResults({ orgId: org.orgId, actorId: adminId, surveyId: draft.id });
      assert.equal(full.responded, 2);
      assert.equal(full.comments[0]!.texts.length, 2);
      const scoped = await getSurveyResults({ orgId: org.orgId, actorId: managerA, surveyId: draft.id });
      assert.equal(scoped.invitations, 1);
      assert.equal(scoped.responded, 1);
      assert.equal(scoped.enps?.responses, 1);
      assert.equal(scoped.enps?.score, 100);
      assert.equal(scoped.comments.length, 0, "one in-scope response clears no minimum of two");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  } finally {
    if (priorSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = priorSecret;
  }
});

test("H-SURVEYS: create, list, edit, and close are scoped", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableFeatures(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Survey Admin", "survey3_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.surveys.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const partyA1 = await seedRespondent(org.orgId, org.subsidiaryId, "Respondent A1");
    const partyB1 = await seedRespondent(org.orgId, subB, "Respondent B1");
    const managerA = await createScratchUser(org.orgId, "Survey Manager A", "survey3_mgr_a");
    await scopeRole(org.orgId, "survey3_mgr_a", ["hrm.surveys.manage"], [org.subsidiaryId]);

    // A B-only survey is invisible to the A lens — list, get, and results
    // all refuse exactly like a fabricated id.
    const bDraft = await saveSurvey({
      orgId: org.orgId, actorId: adminId, name: `Exit ${randomUUID().slice(0, 8)}`,
      kind: "exit", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
    });
    await openSurvey({ orgId: org.orgId, actorId: adminId, surveyId: bDraft.id, partyIds: [partyB1] });
    const listed = await listSurveys({ orgId: org.orgId, actorId: managerA });
    assert.ok(!listed.some((s) => s.id === bDraft.id), "B-only survey never lists");
    const fabricated = randomUUID();
    assert.deepEqual(
      await refusalOf(getSurvey({ orgId: org.orgId, actorId: managerA, surveyId: bDraft.id })),
      await refusalOf(getSurvey({ orgId: org.orgId, actorId: managerA, surveyId: fabricated })),
    );
    assert.deepEqual(
      await refusalOf(getSurveyResults({ orgId: org.orgId, actorId: managerA, surveyId: bDraft.id })),
      await refusalOf(getSurveyResults({ orgId: org.orgId, actorId: managerA, surveyId: fabricated })),
    );

    // Opening to B refuses like a foreign party; opening to A succeeds.
    const ownDraft = await saveSurvey({
      orgId: org.orgId, actorId: managerA, name: `Custom ${randomUUID().slice(0, 8)}`,
      kind: "custom", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
    });
    // The respondent-free draft edits for the in-scope actor.
    const edited = await saveSurvey({
      orgId: org.orgId, actorId: managerA, surveyId: ownDraft.id, name: "Renamed A",
      kind: "custom", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
    });
    assert.equal(edited.name, "Renamed A");
    const openB = await refusalOf(
      openSurvey({ orgId: org.orgId, actorId: managerA, surveyId: ownDraft.id, partyIds: [partyB1] }),
    );
    const openForeign = await refusalOf(
      openSurvey({ orgId: org.orgId, actorId: managerA, surveyId: ownDraft.id, partyIds: [randomUUID()] }),
    );
    assert.deepEqual(openB, openForeign);
    assert.match(openB.message, /not in this organization/);
    const openedA = await openSurvey({
      orgId: org.orgId, actorId: managerA, surveyId: ownDraft.id, partyIds: [partyA1],
    });
    assert.equal(openedA.deliveries.length, 1);

    // The mixed survey lists (it has an in-scope invitee) but neither
    // edits nor closes for the restricted actor — mutations need every
    // respondent in scope.
    const mixedDraft = await saveSurvey({
      orgId: org.orgId, actorId: adminId, name: `Mixed ${randomUUID().slice(0, 8)}`,
      kind: "engagement", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
    });
    await openSurvey({
      orgId: org.orgId, actorId: adminId, surveyId: mixedDraft.id, partyIds: [partyA1, partyB1],
    });
    assert.ok((await listSurveys({ orgId: org.orgId, actorId: managerA })).some((s) => s.id === mixedDraft.id));
    const editMixed = await refusalOf(
      saveSurvey({
        orgId: org.orgId, actorId: managerA, surveyId: mixedDraft.id, name: "Renamed",
        kind: "engagement", anonymity: "named", minGroupSize: 2, questions: QUESTIONS,
      }),
    );
    assert.equal(editMixed.code, "NOT_FOUND");
    const closeMixed = await refusalOf(
      closeSurvey({ orgId: org.orgId, actorId: managerA, surveyId: mixedDraft.id }),
    );
    assert.equal(closeMixed.code, "NOT_FOUND");

    // The opened A-only survey closes for the in-scope actor.
    assert.equal(
      (await closeSurvey({ orgId: org.orgId, actorId: managerA, surveyId: ownDraft.id })).status, "closed",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
