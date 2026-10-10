import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/employments (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). The engine's proposeFirstEmployment owns the full hire
 * contract; the boundary pins the shape it can pin — ids, the hire
 * statuses the payload contract accepts, and a non-blank reason.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
export const hireAssignmentBody = z.object({
  assignmentKey: z.string().trim().min(1).max(120),
  jobTitle: z.string().trim().min(1).max(240).nullable().optional(),
  departmentId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  fte: z.string().trim().min(1).optional(),
  isPrimary: z.boolean().optional(),
  managerEmploymentId: uuid.nullable().optional(),
  positionId: uuid.nullable().optional(),
});
export const hireEmploymentBody = z.object({
  workerPartyId: uuid,
  employerSubsidiaryId: uuid,
  status: z.enum(["offered", "active", "on_leave", "suspended"]).optional(),
  effectiveFrom: z.string().trim().min(1),
  effectiveTo: z.string().trim().min(1).nullable().optional(),
  // The first assignment riding the hire, effective over the hire's
  // window. The engine's hire payload contract owns the full validation;
  // the boundary pins the shape it can pin.
  initialAssignment: hireAssignmentBody.optional(),
  reason: z.string().trim().min(1).max(500),
  // Action/reason classification: required on authoring once the org
  // declares an active reason code; optional while none is declared.
  action: z.string().trim().min(1).max(60).optional(),
  reasonCode: z.string().trim().min(1).max(120).optional(),
});
