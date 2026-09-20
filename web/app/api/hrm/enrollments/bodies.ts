import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/enrollments/*. The engine enrollment
 * service owns the full contract (in-service employment, plan scope,
 * waiting period, tier validity, overlap, component links); the boundary
 * pins the shape it can pin. Amounts are never caller-supplied — the
 * service copies them from the plan basis at election.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");
const reason = z.string().trim().min(1, "reason required").max(2000);

const electBase = z.object({
  employmentId: uuid,
  planId: uuid,
  windowId: uuid.nullish(),
  coverageLevelKey: z.string().trim().min(1).max(120).nullish(),
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

export const approveEnrollmentBody = z.object({ action: z.literal("approve") });

export const changeEnrollmentBody = z.object({
  action: z.literal("change"),
  changeDate: civilDate,
  coverageLevelKey: z.string().trim().min(1).max(120).nullish(),
  reason,
});

export const endEnrollmentBody = z.object({
  action: z.literal("end"),
  endedOn: civilDate.nullish(),
  reason,
});

export const cancelEnrollmentBody = z.object({ action: z.literal("cancel"), reason });

export const enrollmentPatchBody = z.discriminatedUnion("action", [
  approveEnrollmentBody,
  changeEnrollmentBody,
  endEnrollmentBody,
  cancelEnrollmentBody,
]);

export const linkDependentBody = z.object({
  action: z.enum(["link", "unlink"]),
  dependentId: uuid,
});

export { enrollmentId };
