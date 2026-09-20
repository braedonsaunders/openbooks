import { z } from "zod";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm construction-compliance routes. Every
 * JSON mutation route parses a typed zod schema, never the bare object;
 * the engine service owns the full contract.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const decimal = z.string().regex(/^\d+(\.\d{1,4})?$/, "must be a decimal with up to 4 fraction digits");
const text255 = z.string().trim().min(1).max(255);

export const createClassificationBody = z.object({
  code: text255,
  name: z.string().trim().min(1).max(240),
  trade: z.string().trim().min(1).max(240),
  isApprentice: z.boolean().optional(),
  apprenticeProgramRef: z.string().trim().max(240).nullable().optional(),
  journeyClassificationId: uuid.nullable().optional(),
});

export const assignClassificationBody = z.object({
  employmentId: uuid,
  classificationId: uuid,
  effectiveFrom: civilDate,
  homeScheduleId: uuid.nullable().optional(),
});

const appliesTo = z
  .object({
    employer_subsidiary_id: uuid.nullable().optional(),
    department_id: uuid.nullable().optional(),
    project_ids: z.array(uuid).nullable().optional(),
    location_ids: z.array(uuid).nullable().optional(),
  })
  .default({});

export const createScheduleBody = z.object({
  kind: z.enum(["prevailing_wage", "union_agreement", "org_declared"]),
  name: z.string().trim().min(1).max(240),
  sourceRef: z.string().trim().max(240).nullable().optional(),
  jurisdictionCode: z.string().trim().max(120).nullable().optional(),
  appliesTo,
  reciprocity: z.enum(["home_local", "jobsite_local", "higher_of"]),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullable().optional(),
});

export const updateScheduleScopeBody = z.object({
  scheduleId: uuid,
  appliesTo,
});

export const addScheduleLineBody = z.object({
  scheduleId: uuid,
  classificationId: uuid,
  baseRate: decimal,
  fringeRate: decimal.optional(),
  fringeCreditRate: decimal.optional(),
  overtimeMultiplier: decimal.optional(),
  currency: z.string().trim().length(3),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullable().optional(),
});

export const resolveWageBody = z.object({
  employmentId: uuid,
  projectId: uuid.nullable().optional(),
  workedOn: civilDate,
});

export const createPerDiemPolicyBody = z.object({
  name: z.string().trim().min(1).max(240),
  basis: z.enum(["flat_daily", "distance_brackets", "hours_threshold"]),
  rules: z.record(z.string(), z.unknown()),
  lodgingOffset: decimal.nullable().optional(),
  weeklyRule: z.object({ worked_days: z.number().int(), paid_days: z.number().int() }).nullable().optional(),
  payComponentId: uuid.nullable().optional(),
  currency: z.string().trim().length(3),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullable().optional(),
});

export const computeWeekBody = z.object({
  employmentId: uuid,
  weekStart: civilDate,
  kind: z.enum(["per_diem", "travel"]).default("per_diem"),
  travelMode: z.enum(["hourly", "per_km", "bracketed"]).optional(),
});

export const entryActionBody = z.object({
  action: z.enum(["approve", "void"]),
  entryId: uuid,
  kind: z.enum(["per_diem", "travel"]),
  reason: z.string().trim().min(1).max(2000).optional(),
});

export const createCompClassBody = z.object({
  code: text255,
  name: z.string().trim().min(1).max(240),
  jurisdictionCode: z.string().trim().max(120).nullable().optional(),
  ratePer100: decimal.nullable().optional(),
  effectiveFrom: civilDate,
});

export const createCompRuleBody = z.object({
  priority: z.number().int().min(0),
  match: z.record(z.string(), z.unknown()),
  compClassId: uuid,
});

export const splitBody = z.object({
  projectId: uuid,
  workedOn: civilDate,
});

export const generateCertifiedBody = z.object({
  projectId: uuid,
  weekEnding: civilDate,
  formatKey: z.string().trim().min(1).max(120),
});

export const certifiedActionBody = z.object({
  action: z.enum(["submit", "amend", "download"]),
  runId: uuid,
});

export const createRatioRuleBody = z.object({
  scheduleId: uuid,
  journeyClassificationId: uuid,
  apprenticeClassificationId: uuid,
  ratioJourney: z.number().int().min(1),
  ratioApprentice: z.number().int().min(1),
  measured: z.enum(["daily", "weekly"]),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullable().optional(),
});

export const checkDayBody = z.object({
  projectId: uuid,
  workedOn: civilDate,
});

export const findingActionBody = z.object({
  action: z.enum(["acknowledge", "resolve"]),
  findingId: uuid,
  reason: z.string().trim().min(1).max(2000).optional(),
});
