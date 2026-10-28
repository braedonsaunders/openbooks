import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedWorkerEmployment } =
  await import("@openbooks/engine/testing/fixtures");
const { getSurvey } = await import("@openbooks/engine/hrm/surveys/surveys");
const { listOwnInvitations } = await import("@openbooks/engine/hrm/surveys/responses");
const { loadCandidate } = await import("@openbooks/engine/hrm/recruiting/candidates");
const { loadApplication } = await import("@openbooks/engine/hrm/recruiting/applications");
const { getTrainingCourse, getTrainingParticipant, getTrainingSession } =
  await import("@openbooks/engine/hrm/training");
const { createQualificationType, loadSettings } =
  await import("@openbooks/engine/hrm/qualifications/types");
const { listQualifications, loadQualification } =
  await import("@openbooks/engine/hrm/qualifications/qualifications");
const { getGoal } = await import("@openbooks/engine/hrm/performance/goals");
const { listFrameworks } = await import("@openbooks/engine/hrm/performance/competencies");
const { getCycleDetail, getReviewDetail } =
  await import("@openbooks/engine/hrm/performance/performance-read");
const { getFeedbackSettings } = await import("@openbooks/engine/hrm/performance/feedback");
const { compensationSettings } = await import("@openbooks/engine/hrm/compensation/architecture");
const { cyclePacing, getCycle } = await import("@openbooks/engine/hrm/compensation/cycles");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function contextFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Talent test",
        orgId,
        roles: [{ key: "talent-test", name: "Talent test" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
    appBaseUrl: "https://example.test",
  };
}

async function enableFeatures(orgId: string, features: Record<string, boolean>) {
  await withBypassContext(async () => {
    const rows = await db.execute<{ id: string }>(
      sql`
      update orgs
         set settings = jsonb_set(
           settings,
           '{features}',
           coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb,
           true
         )
       where id = ${orgId}
       returning id
    `,
      "objects",
    );
    assert.equal(rows.length, 1, "feature settings update must match the scratch organization");
  });
}

test(
  "talent commands drive recruiting, performance, training, certification, compensation, and survey workflows",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actors = await withBypassContext(() => seedFlowActors(org.orgId));
      await enableFeatures(org.orgId, {
        hrm: true,
        hrmRecruiting: true,
        hrmPerformance: true,
        hrmCompensation: true,
        payroll: true,
        hrmCertifications: true,
        hrmTraining: true,
        hrmSurveys: true,
      });
      const permissions = [
        "hrm.recruiting.manage",
        "hrm.recruiting.read",
        "hrm.surveys.manage",
        "hrm.self.read",
        "hrm.performance.manage",
        "hrm.certifications.manage",
        "hrm.certifications.read",
        "hrm.compensation.manage",
        "hrm.compensation.read",
      ];
      const ctx = contextFor(org.orgId, actors.adminId, permissions);
      const run = (name: string, input: Record<string, unknown>) =>
        withOrgContext(org.orgId, () => executeApplicationTool(applicationTool(name)!, ctx, input));

      const adminPartyId = randomUUID();
      const workerPartyId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name)
          values (${adminPartyId}, ${org.orgId}, 'person', 'Talent Admin'),
                 (${workerPartyId}, ${org.orgId}, 'person', 'Talent Worker')
        `);
        const linked = await db.execute<{ id: string }>(
          sql`
          update users set party_id = ${adminPartyId}
           where org_id = ${org.orgId} and id = ${actors.adminId}
          returning id
        `,
          "objects",
        );
        assert.equal(linked.length, 1, "training author identity must match the scratch admin");
        const workerLinked = await db.execute<{ id: string }>(
          sql`
          update users set party_id = ${workerPartyId}
           where org_id = ${org.orgId} and id = ${actors.submitterId}
          returning id
        `,
          "objects",
        );
        assert.equal(workerLinked.length, 1, "review subject identity must match the employee");
      });
      const employmentId = await withBypassContext(() =>
        seedWorkerEmployment(org.orgId, workerPartyId, org.subsidiaryId),
      );
      await withBypassContext(async () => {
        const version = await db.execute<{ employment_id: string }>(
          sql`
          insert into worker_employment_versions
            (org_id, employment_id, version_no, status, effective_from, recorded_at)
          values (${org.orgId}, ${employmentId}, 1, 'active', '2026-01-01'::date, now())
          returning employment_id
        `,
          "objects",
        );
        assert.equal(
          version.length,
          1,
          "active employment history must match the training subject",
        );
      });

      const frameworkResult = (await run("create_competency_framework", {
        payload: { name: "Talent competency framework", appliesTo: {} },
        idempotencyKey: "talent-framework-create-01",
      })) as { framework: { id: string } };
      const competencyResult = (await run("create_competency", {
        payload: {
          frameworkId: frameworkResult.framework.id,
          code: "SAFE",
          name: "Safety",
          description: "Applies safe work practices.",
          category: "Operations",
        },
        idempotencyKey: "talent-competency-create-01",
      })) as { competency: { id: string } };
      await run("add_competency_level", {
        payload: {
          competencyId: competencyResult.competency.id,
          levelRank: 1,
          label: "Aware",
          expectation: "Identifies common hazards before starting work.",
        },
        idempotencyKey: "talent-competency-level-01",
      });
      let frameworks = await withOrgContext(org.orgId, () =>
        listFrameworks({ orgId: org.orgId, actorId: actors.adminId }),
      );
      let savedFramework = frameworks.find((row) => row.id === frameworkResult.framework.id);
      assert.ok(savedFramework);
      assert.equal(savedFramework.competencies[0]?.levels[0]?.label, "Aware");
      await run("update_competency_framework", {
        frameworkId: frameworkResult.framework.id,
        payload: { action: "setActive", isActive: false },
        idempotencyKey: "talent-framework-disable-01",
      });
      frameworks = await withOrgContext(org.orgId, () =>
        listFrameworks({ orgId: org.orgId, actorId: actors.adminId }),
      );
      savedFramework = frameworks.find((row) => row.id === frameworkResult.framework.id);
      assert.equal(savedFramework?.isActive, false);
      await run("update_competency_framework", {
        frameworkId: frameworkResult.framework.id,
        payload: { action: "setActive", isActive: true },
        idempotencyKey: "talent-framework-enable-01",
      });

      const candidateResult = (await run("create_candidate", {
        payload: { displayName: "Ada Talent", email: "ada.talent@example.test", source: "direct" },
        idempotencyKey: "talent-candidate-create-1",
      })) as { replayed: boolean; candidate: { id: string } };
      assert.equal(candidateResult.replayed, false);
      const candidateId = candidateResult.candidate.id;
      const nativeCandidate = await withOrgContext(org.orgId, () =>
        loadCandidate(db, org.orgId, candidateId),
      );
      assert.equal(nativeCandidate?.displayName, "Ada Talent");

      const replay = (await run("create_candidate", {
        payload: { displayName: "Ada Talent", email: "ada.talent@example.test", source: "direct" },
        idempotencyKey: "talent-candidate-create-1",
      })) as { replayed: boolean; candidate: { id: string } };
      assert.equal(replay.replayed, true);
      assert.equal(replay.candidate.id, candidateId);
      const count = await withOrgContext(org.orgId, () =>
        db.execute<{ count: string }>(
          sql`
          select count(*)::text as count from hrm_candidates
           where org_id = ${org.orgId} and lower(email) = 'ada.talent@example.test'
        `,
          "objects",
        ),
      );
      assert.equal(count[0]?.count, "1");

      const requisition = (await run("create_requisition", {
        payload: {
          title: "Talent workflow analyst",
          employerSubsidiaryId: org.subsidiaryId,
          headcount: 1,
        },
        idempotencyKey: "talent-requisition-create-01",
      })) as { requisition: { id: string } };
      await run("open_requisition", {
        requisitionId: requisition.requisition.id,
        payload: { action: "open" },
        idempotencyKey: "talent-requisition-open-01",
      });
      const application = (await run("attach_candidate_to_requisition", {
        payload: {
          requisitionId: requisition.requisition.id,
          displayName: "Ada Talent",
          email: "ada.talent@example.test",
          mergeInto: candidateId,
        },
        idempotencyKey: "talent-application-attach-01",
      })) as { attached: { application: { id: string } } };
      const offer = (await run("create_offer", {
        payload: {
          applicationId: application.attached.application.id,
          employerSubsidiaryId: org.subsidiaryId,
          jobTitle: "Talent workflow analyst",
          proposedStartOn: "2026-12-01",
          compensationAmount: "50000.00",
          compensationCurrency: "CAD",
          compensationBasis: "annual",
        },
        idempotencyKey: "talent-offer-create-01",
      })) as { offer: { id: string } };
      await run("send_offer", {
        offerId: offer.offer.id,
        payload: { action: "send" },
        idempotencyKey: "talent-offer-send-01",
      });
      const hire = (await run("accept_offer", {
        offerId: offer.offer.id,
        payload: { action: "accept" },
        idempotencyKey: "talent-offer-accept-01",
      })) as { hire: { employmentId: string } };
      const hiredApplication = await withOrgContext(org.orgId, () =>
        loadApplication(db, org.orgId, application.attached.application.id),
      );
      assert.equal(hiredApplication?.status, "hired");
      assert.equal(hiredApplication?.hiredEmploymentId, hire.hire.employmentId);

      const saved = (await run("save_survey", {
        payload: {
          name: "Talent experience",
          kind: "engagement",
          anonymity: "named",
          questions: [{ kind: "scale", prompt: "How supported do you feel?" }],
        },
        idempotencyKey: "talent-survey-save-01",
      })) as { survey: { id: string } };
      const survey = await withOrgContext(org.orgId, () =>
        getSurvey({ orgId: org.orgId, actorId: actors.adminId, surveyId: saved.survey.id }),
      );
      assert.equal(survey.name, "Talent experience");
      await run("open_survey", {
        surveyId: survey.id,
        payload: { partyIds: [adminPartyId] },
        idempotencyKey: "talent-survey-open-01",
      });
      const openSurvey = await withOrgContext(org.orgId, () =>
        getSurvey({ orgId: org.orgId, actorId: actors.adminId, surveyId: survey.id }),
      );
      assert.equal(openSurvey.status, "open");
      const ownInvitations = await withOrgContext(org.orgId, () =>
        listOwnInvitations({ orgId: org.orgId, actorId: actors.adminId }),
      );
      assert.equal(ownInvitations.length, 1);
      await run("respond_to_own_survey", {
        invitationId: ownInvitations[0]!.invitationId,
        payload: {
          answers: [{ questionId: openSurvey.questions[0]!.id, value: 5 }],
        },
        idempotencyKey: "talent-survey-respond-01",
      });
      const afterResponse = await withOrgContext(org.orgId, () =>
        listOwnInvitations({ orgId: org.orgId, actorId: actors.adminId }),
      );
      assert.equal(afterResponse.length, 0);
      await run("close_survey", {
        surveyId: survey.id,
        payload: {},
        idempotencyKey: "talent-survey-close-01",
      });
      const closedSurvey = await withOrgContext(org.orgId, () =>
        getSurvey({ orgId: org.orgId, actorId: actors.adminId, surveyId: survey.id }),
      );
      assert.equal(closedSurvey.status, "closed");

      const reviewQuestionId = randomUUID();
      const reviewSectionId = randomUUID();
      const savedTemplate = (await run("save_review_template", {
        payload: {
          document: {
            name: "Talent review template",
            instructions: "Provide evidence for each rating.",
            ratingScale: {
              min: "1",
              max: "5",
              labels: ["1", "2", "3", "4", "5"],
            },
            sections: [
              {
                id: reviewSectionId,
                title: "Impact",
                kind: "free_text",
                questions: [
                  {
                    id: reviewQuestionId,
                    prompt: "What was the employee's impact?",
                    answerKind: "rating_and_text",
                    required: true,
                  },
                ],
              },
            ],
          },
          publish: true,
          isActive: true,
        },
        idempotencyKey: "talent-review-template-save-01",
      })) as { template: { id: string } };
      const reviewCycle = (await run("create_review_cycle", {
        payload: {
          templateId: savedTemplate.template.id,
          name: "Talent review cycle",
          periodStartOn: "2026-10-01",
          periodEndOn: "2026-10-26",
          requireManagerReviews: false,
        },
        idempotencyKey: "talent-review-cycle-create-01",
      })) as { cycle: { id: string } };
      await run("launch_review_cycle", {
        cycleId: reviewCycle.cycle.id,
        payload: { action: "open" },
        idempotencyKey: "talent-review-cycle-open-01",
      });
      const cycleRead = await withOrgContext(org.orgId, () =>
        getCycleDetail({
          orgId: org.orgId,
          actorId: actors.adminId,
          cycleId: reviewCycle.cycle.id,
        }),
      );
      const selfReview = cycleRead.reviews.find((row) => row.kind === "self");
      assert.ok(selfReview, "opening the cycle must instantiate the employee's self-review");
      const reviewContext = contextFor(org.orgId, actors.submitterId, []);
      const reviewDraft = await withOrgContext(org.orgId, () =>
        getReviewDetail({
          orgId: org.orgId,
          actorId: actors.submitterId,
          reviewId: selfReview.id,
        }),
      );
      await withOrgContext(org.orgId, () =>
        executeApplicationTool(applicationTool("submit_review")!, reviewContext, {
          reviewId: selfReview.id,
          payload: {
            action: "submit",
            revision: reviewDraft.review.revision,
            answers: [
              {
                answerId: reviewDraft.answers[0]!.id,
                rating: "4",
                text: "Consistently delivered the planned work.",
              },
            ],
            overallRating: "4",
          },
          idempotencyKey: "talent-review-submit-01",
        }),
      );
      const submittedReview = await withOrgContext(org.orgId, () =>
        getReviewDetail({
          orgId: org.orgId,
          actorId: actors.submitterId,
          reviewId: selfReview.id,
        }),
      );
      assert.equal(submittedReview.review.status, "submitted");
      await run("close_review_cycle", {
        cycleId: reviewCycle.cycle.id,
        payload: { action: "close" },
        idempotencyKey: "talent-review-cycle-close-01",
      });
      const closedCycle = await withOrgContext(org.orgId, () =>
        getCycleDetail({
          orgId: org.orgId,
          actorId: actors.adminId,
          cycleId: reviewCycle.cycle.id,
        }),
      );
      assert.equal(closedCycle.status, "closed");

      const goal = (await run("create_goal", {
        payload: {
          employmentId,
          title: "Complete safety training",
          weight: "1.00",
        },
        idempotencyKey: "talent-goal-create-01",
      })) as { goal: { id: string } };
      const goalRead = await withOrgContext(org.orgId, () =>
        getGoal({ orgId: org.orgId, actorId: actors.adminId, goalId: goal.goal.id }),
      );
      assert.equal(goalRead.goal.title, "Complete safety training");
      await run("update_goal_progress", {
        goalId: goal.goal.id,
        payload: { action: "progress", progressPercent: 40, note: "Training is scheduled" },
        idempotencyKey: "talent-goal-progress-01",
      });
      const updatedGoal = await withOrgContext(org.orgId, () =>
        getGoal({ orgId: org.orgId, actorId: actors.adminId, goalId: goal.goal.id }),
      );
      assert.equal(updatedGoal.goal.progressPercent, 40);

      await run("update_feedback_settings", {
        payload: { publicPraiseBy: "managers_and_hr" },
        idempotencyKey: "talent-feedback-settings-01",
      });
      const feedbackSettings = await withOrgContext(org.orgId, () =>
        getFeedbackSettings({ orgId: org.orgId, actorId: actors.adminId }),
      );
      assert.equal(feedbackSettings.publicPraiseBy, "managers_and_hr");

      await run("set_qualification_alert_schedule", {
        payload: { leadDays: [14, 7] },
        idempotencyKey: "talent-qualification-alerts-01",
      });
      const qualificationSettings = await withOrgContext(org.orgId, () =>
        loadSettings(db, org.orgId),
      );
      assert.deepEqual(qualificationSettings.alertLeadDays, [14, 7]);

      const qualificationType = await withOrgContext(org.orgId, () =>
        createQualificationType(db, {
          orgId: org.orgId,
          actorId: actors.adminId,
          code: `CERT-${randomUUID().slice(0, 8)}`,
          name: "Talent safety certification",
          category: "certification",
          validityMonths: null,
          requiresEvidence: false,
        }),
      );
      await run("record_qualification", {
        payload: {
          employmentId,
          typeId: qualificationType.id,
          issuedOn: "2026-10-01",
          expiresOn: null,
        },
        idempotencyKey: "talent-qualification-record-01",
      });
      const qualifications = await withOrgContext(org.orgId, () =>
        listQualifications(db, { orgId: org.orgId, actorId: actors.adminId, employmentId }),
      );
      assert.equal(qualifications.length, 1);
      assert.equal(qualifications[0]?.type.id, qualificationType.id);
      const qualificationId = qualifications[0]!.id;
      await run("verify_qualification", {
        qualificationId,
        payload: { reason: "Reviewed the submitted certification record." },
        idempotencyKey: "talent-qualification-verify-01",
      });
      const verifiedQualification = await withOrgContext(org.orgId, () =>
        loadQualification(db, {
          orgId: org.orgId,
          actorId: actors.adminId,
          qualificationId,
        }),
      );
      assert.equal(verifiedQualification?.status, "valid");

      const courseResult = (await run("create_training_course", {
        payload: {
          subsidiaryId: org.subsidiaryId,
          code: `TAL-${randomUUID().slice(0, 8)}`,
          version: 1,
          name: "Talent safety course",
          description: null,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          qualificationTypeId: null,
          minimumAttendancePercent: 0,
          passingScore: null,
          reason: "Create an approved test course",
        },
        idempotencyKey: "talent-training-course-create-01",
      })) as { course: { id: string; revision: number } };
      const course = courseResult.course;
      await run("submit_training_course", {
        courseId: course.id,
        payload: {
          action: "submit",
          expectedRevision: course.revision,
          reason: "Publish the validated training course",
        },
        idempotencyKey: "talent-training-course-submit-01",
      });
      const courseRead = await withOrgContext(org.orgId, () =>
        getTrainingCourse({ orgId: org.orgId, actorId: actors.adminId, courseId: course.id }),
      );
      assert.equal(courseRead.course.status, "approved");

      const sessionResult = (await run("create_training_session", {
        courseId: course.id,
        payload: {
          name: "Talent safety session",
          location: "Training room",
          startsAt: "2026-10-26T09:00:00-04:00",
          endsAt: "2026-10-26T10:00:00-04:00",
          timeZone: "America/Toronto",
          capacity: 4,
          reason: "Create a scheduled training session",
        },
        idempotencyKey: "talent-training-session-create-01",
      })) as { session: { id: string; revision: number } };
      const session = sessionResult.session;
      await run("schedule_training_session", {
        sessionId: session.id,
        payload: {
          action: "schedule",
          expectedRevision: session.revision,
          reason: "Publish session",
        },
        idempotencyKey: "talent-training-session-schedule-01",
      });
      const invitation = await run("invite_training_participant", {
        sessionId: session.id,
        payload: { employmentId, reason: "Assign required safety training" },
        idempotencyKey: randomUUID(),
      });
      const participantId = (invitation as { participant: { id: string } }).participant.id;
      const invitedSession = await withOrgContext(org.orgId, () =>
        getTrainingSession({ orgId: org.orgId, actorId: actors.adminId, sessionId: session.id }),
      );
      assert.equal(invitedSession.participants[0]?.id, participantId);
      await run("accept_training_invitation", {
        participantId,
        payload: {
          action: "accept",
          expectedRevision: invitedSession.participants[0]!.revision,
          reason: "Confirm attendance",
        },
        idempotencyKey: "talent-training-invitation-accept-01",
      });
      await run("start_training_session", {
        sessionId: session.id,
        payload: {
          action: "start",
          expectedRevision: invitedSession.session.revision,
          reason: "Begin scheduled training",
        },
        idempotencyKey: "talent-training-session-start-01",
      });
      const startedSession = await withOrgContext(org.orgId, () =>
        getTrainingSession({ orgId: org.orgId, actorId: actors.adminId, sessionId: session.id }),
      );
      assert.equal(startedSession.session.status, "in_progress");
      await run("complete_training_participant", {
        participantId,
        payload: {
          expectedRevision: startedSession.participants[0]!.revision,
          attendanceSeconds: startedSession.session.durationSeconds,
          score: null,
          evidenceFileId: null,
          existingQualificationId: null,
          notes: null,
          reason: "Record completed attendance",
        },
        idempotencyKey: "talent-training-participant-complete-01",
      });
      const participantRead = await withOrgContext(org.orgId, () =>
        getTrainingParticipant({
          orgId: org.orgId,
          actorId: actors.adminId,
          participantId,
          audience: "staff",
        }),
      );
      assert.equal(participantRead.participant.status, "completed");

      const cycle = (await run("create_compensation_cycle", {
        payload: {
          name: "Talent merit cycle",
          kind: "merit",
          effectiveOn: "2026-10-01",
          currency: "CAD",
          guidelineKind: "matrix",
          guideline: {},
          scope: { employerSubsidiaryId: org.subsidiaryId },
        },
        idempotencyKey: "talent-compensation-cycle-create-01",
      })) as { cycle: { id: string } };
      const cycleId = cycle.cycle.id;
      await run("set_compensation_cycle_budgets", {
        cycleId,
        payload: {
          budgets: [{ managerPartyId: adminPartyId, currency: "CAD", amount: "1000.00" }],
        },
        idempotencyKey: "talent-compensation-budget-set-01",
      });
      const compensationCycleRead = await withOrgContext(org.orgId, () =>
        getCycle({ orgId: org.orgId, actorId: actors.adminId, cycleId }),
      );
      assert.equal(compensationCycleRead.id, cycleId);
      const pacing = await withOrgContext(org.orgId, () =>
        cyclePacing(org.orgId, actors.adminId, cycleId),
      );
      assert.equal(pacing.overBudget, false);

      await run("update_compensation_settings", {
        payload: { gapThresholdPct: "3.75", burdenRate: "0.2" },
        idempotencyKey: "talent-compensation-settings-01",
      });
      const savedCompensationSettings = await withOrgContext(org.orgId, () =>
        compensationSettings(org.orgId),
      );
      assert.equal(savedCompensationSettings.gapThresholdPct, "3.75");
      assert.equal(savedCompensationSettings.burdenRate, "0.2");

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          executeApplicationTool(
            applicationTool("create_candidate")!,
            contextFor(org.orgId, actors.adminId, []),
            {
              payload: { displayName: "No Grant" },
              idempotencyKey: "talent-permission-01",
            },
          ),
        ),
        /forbidden/i,
      );

      await enableFeatures(org.orgId, { hrmRecruiting: false });
      await assert.rejects(
        run("create_candidate", {
          payload: { displayName: "Feature Off" },
          idempotencyKey: "talent-feature-off-01",
        }),
        /not found/i,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("talent survey reads keep another organization's survey hidden", { skip: !DB }, async () => {
  const first = await withBypassContext(() => createScratchOrg());
  const second = await withBypassContext(() => createScratchOrg());
  try {
    const firstActors = await withBypassContext(() => seedFlowActors(first.orgId));
    const secondActors = await withBypassContext(() => seedFlowActors(second.orgId));
    await enableFeatures(first.orgId, { hrm: true, hrmSurveys: true });
    await enableFeatures(second.orgId, { hrm: true, hrmSurveys: true });
    const owner = contextFor(first.orgId, firstActors.adminId, ["hrm.surveys.manage"]);
    const created = (await withOrgContext(first.orgId, () =>
      executeApplicationTool(applicationTool("save_survey")!, owner, {
        payload: {
          name: "Private survey",
          kind: "pulse",
          anonymity: "named",
          questions: [{ kind: "text", prompt: "What should improve?" }],
        },
        idempotencyKey: "talent-private-survey-1",
      }),
    )) as { survey: { id: string } };
    const otherOrgContext = contextFor(second.orgId, secondActors.adminId, ["hrm.surveys.manage"]);
    await assert.rejects(
      withOrgContext(second.orgId, () =>
        executeApplicationTool(applicationTool("get_survey")!, otherOrgContext, {
          surveyId: created.survey.id,
        }),
      ),
    );
  } finally {
    await dropScratchOrg(first.orgId);
    await dropScratchOrg(second.orgId);
  }
});
