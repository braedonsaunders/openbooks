import "server-only";
import { z } from "zod";
import {
  acknowledgeMyReview,
  changeMyBenefit,
  electMyBenefit,
  fileBankDetailsChange,
  fileProfileChangeRequest,
  submitMySelfAssessment,
  updateMyGoalProgress,
} from "@openbooks/engine/hrm/self-service";
import { normalizeCountryCode } from "../countries";
import { ApplicationError } from "./errors";
import {
  describeObjectFields,
  hrmMutation,
  HRM_DATE,
  HRM_UUID,
  hrmShortText,
} from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";
import {
  acknowledgeReviewBody,
  changeBenefitBody,
  electBenefitBody,
  fileBankChangeBody,
  fileProfileChangeBody,
  goalProgressBody,
  submitSelfAssessmentBody,
} from "../../app/api/hrm/me/bodies";

const providerContributionTerm = z
  .discriminatedUnion("electionMode", [
    z.object({
      ruleId: HRM_UUID.describe("Contribution rule id from the native plan read."),
      electionMode: z.literal("fixed").describe("Elected fixed contribution mode."),
      electedRate: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("Exact selected contribution rate as a decimal string."),
      declaredPeriodsPerYear: z
        .number()
        .int()
        .min(1)
        .max(366)
        .nullable()
        .optional()
        .describe("Declared pay periods in the year, when required by the plan."),
    }),
    z.object({
      ruleId: HRM_UUID.describe("Contribution rule id from the native plan read."),
      electionMode: z.literal("follows_policy").describe("Follow the plan's configured policy."),
      electedRate: z.null().optional().describe("No override rate for this policy mode."),
      declaredPeriodsPerYear: z
        .number()
        .int()
        .min(1)
        .max(366)
        .nullable()
        .optional()
        .describe("Declared pay periods in the year, when required by the plan."),
    }),
  ])
  .describe("One election term for a plan contribution rule.");
const contributionTerms = z
  .array(providerContributionTerm)
  .min(1)
  .max(100)
  .describe("Contribution election terms, up to 100 plan rules.");
const profileInput = describeObjectFields(
  fileProfileChangeBody.extend({
    employmentId: HRM_UUID,
    changes: z
      .looseObject({
        kind: hrmShortText("Profile change kind supported by the HRM profile service.", 120),
      })
      .describe("Requested profile fields and their proposed values."),
  }),
);
const bankInput = describeObjectFields(fileBankChangeBody.extend({ employmentId: HRM_UUID }));
const submitReviewInput = describeObjectFields(
  submitSelfAssessmentBody.extend({
    reviewId: HRM_UUID,
    answers: z
      .array(
        z.object({
          answerId: HRM_UUID.describe("Review question id from hrm_me."),
          rating: z
            .union([z.string().max(200).describe("Rating value."), z.number()])
            .nullable()
            .optional()
            .describe("Rating for this review question."),
          text: z
            .string()
            .max(4000)
            .nullable()
            .optional()
            .describe("Written response for this review question."),
        }),
      )
      .max(100)
      .describe("Answers to the assigned review questions, up to 100."),
  }),
);
const acknowledgeReviewInput = describeObjectFields(
  acknowledgeReviewBody.extend({ reviewId: HRM_UUID }),
);
const goalInput = describeObjectFields(goalProgressBody.extend({ goalId: HRM_UUID }));
const electBenefitInput = describeObjectFields(
  electBenefitBody.extend({
    employmentId: HRM_UUID,
    planId: HRM_UUID,
    windowId: HRM_UUID.nullable().optional(),
    contributionTerms,
    effectiveFrom: HRM_DATE,
    effectiveTo: HRM_DATE.nullable().optional(),
  }),
);
const changeBenefitInput = describeObjectFields(
  changeBenefitBody.extend({
    enrollmentId: HRM_UUID,
    changeDate: HRM_DATE,
    contributionTerms: contributionTerms.optional(),
  }),
);

export const HRM_SELF_SERVICE_TOOLS: ApplicationToolDefinition[] = [
  hrmMutation({
    name: "file_my_profile_change",
    title: "File My Profile Change",
    description:
      "Submit a change proposal for the key's own profile and employment for HR review. Use the caller's own HRM workspace to find the employment id; the native service binds the request to the signed-in user's party.",
    input: profileInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { request } = await fileProfileChangeRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        changes: input.changes,
        reason: input.reason,
      });
      return { ok: true, request, requestId: request.id, status: request.status, href: "/hrm/me" };
    },
  }),
  hrmMutation({
    name: "file_my_bank_details_change",
    title: "File My Bank Details Change",
    description:
      "Submit the key's own direct-deposit details through the native bank-change approval path. Provide the employment from the caller's own HRM workspace; the service validates and seals the account number and never accepts another person's identity.",
    input: bankInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      if (input.bank.country != null && !normalizeCountryCode(input.bank.country)) {
        throw new ApplicationError(
          "invalid_input",
          "country must be a valid ISO country code",
          400,
        );
      }
      if (input.bank.currency != null && !/^[A-Za-z]{3}$/.test(input.bank.currency.trim())) {
        throw new ApplicationError("invalid_input", "currency must be a 3-letter code", 400);
      }
      const result = await fileBankDetailsChange({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        bank: {
          bankName: input.bank.bankName,
          accountNumber: input.bank.accountNumber,
          ...(input.bank.country === undefined
            ? {}
            : { country: normalizeCountryCode(input.bank.country) ?? input.bank.country }),
          ...(input.bank.currency === undefined
            ? {}
            : {
                currency:
                  input.bank.currency === null ? null : input.bank.currency.trim().toUpperCase(),
              }),
          ...(input.bank.routing === undefined ? {} : { routing: input.bank.routing }),
        },
        reason: input.reason,
      });
      return {
        ok: true,
        ...result,
        requestId: result.request.id,
        status: result.request.status,
        href: "/hrm/me",
      };
    },
  }),
  hrmMutation({
    name: "submit_my_self_assessment",
    title: "Submit My Self Assessment",
    description:
      "Submit the key's own review answers for the assigned review cycle. Find the review id in hrm_me; the native service confirms the caller is the assigned reviewer and that the review is open.",
    input: submitReviewInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const review = await submitMySelfAssessment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        reviewId: input.reviewId,
        answers: input.answers,
        overallRating: input.overallRating,
      });
      return { ok: true, review, reviewId: review.id, status: review.status, href: "/hrm/me" };
    },
  }),
  hrmMutation({
    name: "acknowledge_my_review",
    title: "Acknowledge My Review",
    description:
      "Acknowledge a review shared with the key's own user. Find the review id in hrm_me; the native service confirms the caller is the subject and the review has been shared.",
    input: acknowledgeReviewInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const review = await acknowledgeMyReview({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        reviewId: input.reviewId,
      });
      return { ok: true, review, reviewId: review.id, status: review.status, href: "/hrm/me" };
    },
  }),
  hrmMutation({
    name: "update_my_goal_progress",
    title: "Update My Goal Progress",
    description:
      "Record progress and an optional note on a goal belonging to the key's own employment. Find goal ids in hrm_me; the native service refuses goals owned by another person.",
    input: goalInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const goal = await updateMyGoalProgress({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        goalId: input.goalId,
        progressPercent: input.progressPercent,
        note: input.note,
      });
      return { ok: true, goal, goalId: input.goalId, href: "/hrm/me" };
    },
  }),
  hrmMutation({
    name: "elect_my_benefit",
    title: "Elect My Benefit",
    description:
      "Elect coverage for an employment linked to the key's own user during a covering open enrollment window. Find plan, window and employment ids in hrm_me; the native service refuses another person's employment or a closed window.",
    input: electBenefitInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const enrollment = await electMyBenefit({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        planId: input.planId,
        windowId: input.windowId,
        classKey: input.classKey,
        matchEligible: input.matchEligible,
        contributionTerms: input.contributionTerms,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        lifeEventReason: input.lifeEventReason,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/me",
      };
    },
  }),
  hrmMutation({
    name: "change_my_benefit",
    title: "Change My Benefit",
    description:
      "Change an active benefit election for the key's own user inside an open covering window. Find the enrollment id in hrm_me; the native service checks ownership, effective date, window and reason.",
    input: changeBenefitInput,
    permission: "hrm.self.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const enrollment = await changeMyBenefit({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        enrollmentId: input.enrollmentId,
        changeDate: input.changeDate,
        classKey: input.classKey,
        matchEligible: input.matchEligible,
        contributionTerms: input.contributionTerms,
        reason: input.reason,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/me",
      };
    },
  }),
];
