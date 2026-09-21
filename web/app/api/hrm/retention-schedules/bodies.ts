import { z } from "zod";

/**
 * Typed request bodies for /api/hrm/retention-schedules and
 * /api/hrm/data-subject-exports (financial-boundary ratchet: every JSON
 * mutation route parses a typed zod schema, never the bare object).
 */
export const saveScheduleBody = z.object({
  scheduleId: z.string().uuid().optional(),
  categoryKey: z.string().trim().min(1).max(80),
  retainYears: z.number().int().min(0).max(100),
  fromEvent: z.enum(["completion", "termination", "creation"]),
  action: z.enum(["delete", "anonymize"]),
  isActive: z.boolean().optional(),
});

export const requestExportBody = z.object({
  partyId: z.string().uuid(),
});
