import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/** Typed request bodies for /api/hrm/recruiting/offers/*. */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const decimal4 = z.string().regex(/^\d+(\.\d{1,4})?$/, "must be a decimal with up to 4 fraction digits");
const reason = z.string().trim().min(1, "reason required").max(2000);

export const createOfferBody = z.object({
  applicationId: uuid,
  positionId: uuid.nullable().optional(),
  employerSubsidiaryId: uuid,
  departmentId: uuid.nullable().optional(),
  jobTitle: z.string().trim().min(1).max(240),
  employmentKind: z.string().trim().min(1).max(120).nullable().optional(),
  proposedStartOn: civilDate,
  compensationAmount: decimal4,
  compensationCurrency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter code"),
  compensationBasis: z.enum(["hourly", "annual"]),
  expiresOn: civilDate.nullable().optional(),
});

export const patchOfferBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send") }),
  // Accepting an offer IS the hire: one transaction filing the hire change
  // request through Flows with the requisition fill.
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("decline"), reason }),
  z.object({ action: z.literal("withdraw"), reason }),
]);
