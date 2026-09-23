import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/exit-records/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object). Recording stays HR (performance manage) in the service;
 * reading stays retention read — the boundary pins the shape it can pin.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const reasonKind = z.enum([
  "resignation",
  "retirement",
  "end_of_contract",
  "dismissal",
  "redundancy",
  "mutual",
  "death",
  "other",
]);

export const recordExitBody = z.object({
  employmentId: uuid,
  terminationChangeId: uuid.nullable().optional(),
  reasonKind,
  isVoluntary: z.boolean(),
  isRegrettable: z.boolean().nullable().optional(),
  wouldRehire: z.boolean().nullable().optional(),
  interviewHeldOn: civilDate.nullable().optional(),
  interviewerPartyId: uuid.nullable().optional(),
  destination: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export const patchExitBody = z.object({
  // The revision read with the record: a stale revision refuses instead
  // of overwriting a newer correction.
  expectedRevision: z.number().int().min(1),
  // Why the record is corrected — stored on the audit event beside the change.
  reason: z.string().trim().max(2000).nullable().optional(),
  reasonKind: reasonKind.optional(),
  isVoluntary: z.boolean().optional(),
  isRegrettable: z.boolean().nullable().optional(),
  wouldRehire: z.boolean().nullable().optional(),
  interviewHeldOn: civilDate.nullable().optional(),
  interviewerPartyId: uuid.nullable().optional(),
  destination: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});
