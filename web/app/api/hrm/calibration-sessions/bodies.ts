import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/calibration-sessions/* and
 * /api/hrm/calibration-entries/[id]. Authority stays HR
 * (hrm.performance.manage) with the facilitator self-refusal in the
 * service; the boundary pins the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");

export const createCalibrationSessionBody = z.object({
  cycleId: uuid,
  name: z.string().trim().min(1).max(240),
  scope: z.record(z.string(), z.unknown()).nullable().optional(),
  facilitatorPartyId: uuid.nullable().optional(),
});

export const patchCalibrationSessionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }),
  z.object({ action: z.literal("close") }),
]);

export const patchCalibrationEntryBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rate"),
    calibratedRating: z.string().regex(/^\d+(\.\d+)?$/, "must be a non-negative number"),
    justification: z.string().trim().min(1).max(4000),
  }),
  z.object({ action: z.literal("potential"), potentialKey: z.string().trim().min(1).max(240) }),
  z.object({ action: z.literal("revert"), reason: z.string().trim().min(1).max(2000) }),
]);
