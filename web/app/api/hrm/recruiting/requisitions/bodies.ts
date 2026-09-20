import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/recruiting/requisitions/* (financial
 * boundary ratchet: every JSON mutation route parses a typed zod schema,
 * never the bare object). The engine service owns the full contract
 * (lifecycle, vacancy proofs, compensation pairing); the boundary pins the
 * shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const decimal4 = z.string().regex(/^\d+(\.\d{1,4})?$/, "must be a decimal with up to 4 fraction digits");
const text255 = z.string().trim().min(1).max(255);
const reason = z.string().trim().min(1, "reason required").max(2000);

const compensation = z
  .object({
    min: decimal4,
    max: decimal4,
    currency: z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter code"),
    basis: z.enum(["hourly", "annual"]),
  })
  .nullable()
  .optional();

export const createRequisitionBody = z.object({
  title: z.string().trim().min(1).max(240),
  positionId: uuid.nullable().optional(),
  employerSubsidiaryId: uuid,
  departmentId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  hiringManagerPartyId: uuid.nullable().optional(),
  recruiterUserId: uuid.nullable().optional(),
  headcount: z.number().int().min(1),
  employmentKind: z.string().trim().min(1).max(120).nullable().optional(),
  targetStartOn: civilDate.nullable().optional(),
  compensation,
  pipelineTemplateId: uuid.nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
});

export const patchRequisitionBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    targetStartOn: civilDate.nullable().optional(),
    overEstablishment: z.boolean().optional(),
  }),
  z.object({ action: z.literal("hold"), reason }),
  z.object({ action: z.literal("resume"), reason }),
  z.object({ action: z.literal("cancel"), reason }),
]);
