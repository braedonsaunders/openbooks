import { z } from "zod";
import { canonicalDecimal, isPositiveDecimal } from "@openbooks/engine/src/money/exact-decimal.ts";
import { isUuid } from "../../../../lib/list-params";
import { decimalNullRefusal, suppliedValue } from "../../../../lib/payroll-decimal-refusal";

/**
 * Typed request bodies for /api/hrm/compensation/* (financial-boundary
 * ratchet: every JSON mutation route parses a typed zod schema, never the
 * bare object).
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
// A band/cycle/line amount must retain its exact decimal spelling across the
// JSON boundary. Numeric JSON values have already crossed IEEE-754 and are
// refused with a remedy instead of being stringified.
const money4 = (field: string) =>
  z.string({ error: `${field} must be sent as a decimal string, not a JSON number` }).transform((raw, ctx) => {
    const exact = canonicalDecimal(raw, 4);
    if (exact === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: decimalNullRefusal(field, "a positive amount with at most 4 decimals", raw, 4),
      });
      return z.NEVER;
    }
    if (!isPositiveDecimal(exact)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be greater than zero — got "${suppliedValue(raw)}"`,
      });
      return z.NEVER;
    }
    return exact;
  });
const currency = z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code");

export const createFamilyBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const updateFamilyBody = z.object({
  name: z.string().trim().min(1).max(160).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
});

const criterion = z.enum(["skills", "effort", "responsibility", "working_conditions"]);

export const createLevelBody = z.object({
  familyId: uuid.nullable().optional(),
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(160),
  rank: z.number().int().min(1),
  equalValueCriteria: z.array(z.object({ criterion, weight: z.string().regex(/^\d+(\.\d+)?$/) })).min(1),
});

export const updateLevelBody = z.object({
  name: z.string().trim().min(1).max(160).nullable().optional(),
  rank: z.number().int().min(1).nullable().optional(),
  equalValueCriteria: z
    .array(z.object({ criterion, weight: z.string().regex(/^\d+(\.\d+)?$/) }))
    .min(1)
    .nullable()
    .optional(),
  isActive: z.boolean().nullable().optional(),
  reason: z.string().trim().min(1).max(2000),
});

export const createBandBody = z.object({
  familyId: uuid.nullable().optional(),
  levelId: uuid,
  employerSubsidiaryId: uuid.nullable().optional(),
  locationId: uuid.nullable().optional(),
  currency,
  basis: z.enum(["annual", "hourly"]),
  min: money4("Band min"),
  target: money4("Band target"),
  max: money4("Band max"),
  effectiveFrom: civilDate,
  reason: z.string().trim().min(1).max(2000),
});

export const createCycleBody = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["merit", "promotion", "adjustment", "cola"]),
  effectiveOn: civilDate,
  budgetBasis: z.enum(["top_down", "bottom_up", "combined"]).optional(),
  budgetTotal: money4("Budget total").nullable().optional(),
  currency,
  guidelineKind: z.enum(["matrix", "formula"]),
  guideline: z.record(z.string(), z.unknown()),
  scope: z
    .object({ employerSubsidiaryId: uuid.nullable().optional(), departmentId: uuid.nullable().optional() })
    .optional(),
});

export const setBudgetsBody = z.object({
  budgets: z.array(
    z.object({
      departmentId: uuid.nullable().optional(),
      managerPartyId: uuid.nullable().optional(),
      currency,
      amount: money4("Budget amount"),
    }),
  ),
});

export const proposeLineBody = z.object({
  proposedPct: z.number().nonnegative().nullable().optional(),
  proposedRate: money4("Proposed rate").nullable().optional(),
  reason: z.string().trim().max(2000).nullable().optional(),
});

export const decideLineBody = z.object({
  reason: z.string().trim().min(1).max(2000).nullable().optional(),
});

export const reopenLineBody = z.object({
  reason: z.string().trim().min(1).max(2000),
});

export const createStatementBody = z.object({
  employmentId: uuid,
  cycleId: uuid.nullable().optional(),
  periodFrom: civilDate,
  periodTo: civilDate,
});

export const createPlanBody = z.object({
  name: z.string().trim().min(1).max(160),
  fiscalPeriodFrom: civilDate,
  fiscalPeriodTo: civilDate,
});

export const createPlanLineBody = z.object({
  kind: z.enum(["create", "backfill", "change", "terminate"]),
  positionId: uuid.nullable().optional(),
  title: z.string().trim().min(1).max(200),
  departmentId: uuid.nullable().optional(),
  employerSubsidiaryId: uuid,
  jobLevelId: uuid.nullable().optional(),
  plannedFte: z.string().regex(/^\d+(\.\d{1,4})?$/),
  startOn: civilDate,
  endOn: civilDate.nullable().optional(),
  currency,
  reason: z.string().trim().max(2000).nullable().optional(),
});

export const generateSnapshotBody = z.object({
  asOf: civilDate,
  groupA: z.string().trim().min(1).max(160),
  groupB: z.string().trim().min(1).max(160),
});

export const requestPayInfoBody = z.object({
  employmentId: uuid,
});
