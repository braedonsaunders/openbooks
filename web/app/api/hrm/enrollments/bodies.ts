import { z } from "zod";
import { civilDateInput } from "@/lib/api/civil-date";
import { isUuid } from "../../../../lib/list-params";

/** Native contribution elections are atomic with coverage; the engine validates rates and subject scope. */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = civilDateInput();
const reason = z.string().trim().min(1, "reason required").max(2000);

export const contributionTermBody = z.discriminatedUnion('electionMode', [
  z.object({ruleId: uuid,electionMode: z.literal('fixed'),electedRate: z.string().trim().min(1),declaredPeriodsPerYear: z.number().int().min(1).max(366).nullish()}),
  z.object({ruleId: uuid,electionMode: z.literal('follows_policy'),electedRate: z.null().optional(),declaredPeriodsPerYear: z.number().int().min(1).max(366).nullish()}),
]);
const contributionSelection = {
  classKey: z.string().trim().min(1).max(120).nullish(),
  matchEligible: z.boolean().nullish(),
  contributionTerms: z.array(contributionTermBody).min(1),
};

const electBase = z.object({
  employmentId: uuid,
  planId: uuid,
  windowId: uuid.nullish(),
  ...contributionSelection,
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullish(),
  selfService: z.boolean().optional(),
});

export const electEnrollmentBody = electBase.extend({
  action: z.literal("elect"),
  lifeEventReason: z.string().trim().min(1).max(2000).nullish(),
});

export const waiveEnrollmentBody = electBase
  .pick({ employmentId: true, planId: true, windowId: true, effectiveFrom: true, selfService: true })
  .extend({ action: z.literal("waive"), reason });

export const enrollmentPostBody = z.discriminatedUnion("action", [electEnrollmentBody, waiveEnrollmentBody]);

const enrollmentId = z.object({ enrollmentId: uuid });


export const changeEnrollmentBody = z.object({
  action: z.literal("change"),
  changeDate: civilDate,
  ...contributionSelection,
  contributionTerms: z.array(contributionTermBody).min(1).optional(),
  reason,
});

export const endEnrollmentBody = z.object({
  action: z.literal("end"),
  endedOn: civilDate.nullish(),
  reason,
});

export const cancelEnrollmentBody = z.object({ action: z.literal("cancel"), reason });
export const withdrawEnrollmentBody = z.object({ action: z.literal("withdraw_unused"), reason });

export const enrollmentPatchBody = z.discriminatedUnion("action", [
  changeEnrollmentBody,
  endEnrollmentBody,
  cancelEnrollmentBody,
  withdrawEnrollmentBody,
]);

export const linkDependentBody = z.object({
  action: z.enum(["link", "unlink"]),
  dependentId: uuid,
});

export { enrollmentId };
