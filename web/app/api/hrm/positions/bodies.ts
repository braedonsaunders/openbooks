import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/positions/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). The engine service owns the full contract (status
 * lifecycle, FTE shape, paired cost-plan fields); the boundary pins the
 * shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const fte = z.string().regex(/^\d+(\.\d{1,4})?$/, "must be a decimal with up to 4 fraction digits");
const text255 = z.string().trim().min(1).max(255);
const reason = z.string().trim().min(1, "reason required").max(2000);

export const createPositionBody = z.object({
  positionCode: text255,
  title: z.string().trim().min(1).max(240),
  departmentId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  employerSubsidiaryId: uuid,
  jobGrade: z.string().trim().min(1).max(120).nullable().optional(),
  plannedFte: fte.optional(),
  status: z.enum(["planned", "open", "filled", "frozen", "closed"]).optional(),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullable().optional(),
  reason,
});

export const revisePositionBody = z.object({
  action: z.literal("revise"),
  title: z.string().trim().min(1).max(240).optional(),
  departmentId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  employerSubsidiaryId: uuid.optional(),
  jobGrade: z.string().trim().min(1).max(120).nullable().optional(),
  plannedFte: fte.optional(),
  status: z.enum(["planned", "open", "filled", "frozen"]).optional(),
  effectiveFrom: civilDate.optional(),
  effectiveTo: civilDate.nullable().optional(),
  reason,
});

export const closePositionBody = z.object({
  action: z.literal("close"),
  effectiveDate: civilDate,
  reason,
});

export const fundPositionBody = z.object({
  action: z.literal("fund"),
  periodId: uuid,
  fundedFte: fte,
  fundingSourceId: uuid.nullable().optional(),
  amount: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  reason,
});

export const patchPositionBody = z.discriminatedUnion("action", [
  revisePositionBody,
  closePositionBody,
  fundPositionBody,
]);
