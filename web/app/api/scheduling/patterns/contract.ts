import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";

const clock = z.string().regex(/^\d{2}:\d{2}$/);
const uuid = uuidString();
/** A shift pattern as Setup submits it; the engine validates slots, target and qualifications. */
export const patternBody = z.strictObject({
  subsidiaryId: uuid.nullable(),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  timeZone: z.string().min(1).max(128),
  cycleDays: z.number().int().min(1).max(366),
  cycleAnchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slots: z
    .array(
      z.strictObject({
        position: z.number().int().min(0).max(365),
        starts: clock,
        ends: clock,
        breakMinutes: z.number().int().min(0).max(240),
        qualificationTypeIds: z.array(uuid).max(100).optional(),
      }),
    )
    .min(1)
    .max(1000),
  targetKind: z.enum(["customer", "project", "location", "code"]).nullable().optional(),
  customerPartyId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
  projectTaskId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  scheduleCodeId: uuid.nullable().optional(),
  departmentId: uuid.nullable().optional(),
  detail: z.string().max(120).nullable().optional(),
  horizonDays: z.number().int().min(1).max(366),
  isActive: z.boolean(),
  reason: z.string().trim().min(1).max(2000),
});

export type PatternBody = z.infer<typeof patternBody>;

/** Map the Setup row shape onto the engine's pattern input. */
export function patternInput(body: PatternBody) {
  const targetId =
    body.targetKind === "customer"
      ? body.customerPartyId
      : body.targetKind === "project"
        ? body.projectId
        : body.targetKind === "location"
          ? body.locationId
          : body.targetKind === "code"
            ? body.scheduleCodeId
            : null;
  return {
    subsidiaryId: body.subsidiaryId,
    code: body.code,
    name: body.name,
    description: body.description ?? null,
    timeZone: body.timeZone,
    cycleDays: body.cycleDays,
    cycleAnchor: body.cycleAnchor,
    slots: body.slots.map((slot) => ({
      ...slot,
      qualificationTypeIds: slot.qualificationTypeIds ?? [],
    })),
    target: body.targetKind && targetId ? { kind: body.targetKind, id: targetId } : null,
    projectTaskId: body.targetKind === "project" ? (body.projectTaskId ?? null) : null,
    departmentId: body.departmentId ?? null,
    detail: body.detail ?? null,
    horizonDays: body.horizonDays,
    isActive: body.isActive,
    reason: body.reason,
  };
}
