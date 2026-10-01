import { z } from "zod";
import { isIsoCalendarDate } from "@openbooks/engine/crm/sales/contracts";
import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import { moneyRefusal } from "../payroll-decimal-refusal";

const date = z
  .string()
  .refine(isIsoCalendarDate, "Enter a valid calendar date.");
const nullableId = z.string().uuid().nullable();
const position = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);
const ring = z.array(position).min(4).max(200000);
const geometry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Polygon"), coordinates: z.array(ring).min(1) }),
  z.object({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(ring).min(1)).min(1),
  }),
]);
const boundary = z.object({
  country: z.string().regex(/^[A-Z]{3}$/),
  level: z.enum(["ADM0", "ADM1", "ADM2"]),
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  geometry: geometry
    .optional()
    .transform(
      (value) => value ?? { type: "Polygon" as const, coordinates: [] },
    ),
});
export const salesGeographySchema = z.object({
  version: z.literal(1),
  includes: z.array(boundary).max(200),
  excludes: z.array(boundary).max(200),
  polygons: z
    .array(z.object({ id: z.string(), name: z.string(), geometry }))
    .max(20),
});
const common = {
  id: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200),
  subsidiaryId: z.string().uuid(),
};
const rule = z
  .object({
    field: z.enum([
      "country",
      "region",
      "industry",
      "lifecycleStage",
      "leadSourceId",
      "annualRevenue",
      "employeeCount",
    ]),
    operator: z.enum(["equals", "in", "contains", "gte", "lte"]),
    value: z.union([z.string(), z.array(z.string()), z.number()]),
  })
  .superRefine((r, ctx) => {
    if (r.operator === "in" && !Array.isArray(r.value))
      ctx.addIssue({
        code: "custom",
        message: "The in comparison needs a list of values.",
      });
    if (r.operator !== "in" && Array.isArray(r.value))
      ctx.addIssue({
        code: "custom",
        message: "This comparison needs one value.",
      });
    if (r.field === "annualRevenue")
      for (const v of Array.isArray(r.value) ? r.value : [r.value])
        if (canonicalDecimal(v, 4) === null)
          ctx.addIssue({
            code: "custom",
            message: moneyRefusal("Annual revenue", v),
          });
    if (
      r.field === "employeeCount" &&
      (typeof r.value !== "number" || !Number.isInteger(r.value) || r.value < 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Employee count must be a non-negative whole number.",
      });
  });
export const salesTerritorySchema = z.strictObject({
  ...common,
  action: z.literal("territory"),
  managerEmployeeId: nullableId,
  defaultEmployeeId: nullableId,
  salesTeamId: nullableId,
  description: z.string().max(4000),
  priority: z.number().int().min(0).max(2147483647),
  rules: z.array(rule).max(50),
  matchMode: z.enum(["all", "any"]),
  geography: salesGeographySchema,
  effectiveFrom: date,
  lifecycle: z.enum(["draft", "active", "archived"]),
  previewRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const salesCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("representative"),
    employeeId: z.string().uuid(),
    enabled: z.boolean(),
    since: date,
    expectedRevision: z.string().min(1),
  }),
  z.strictObject({
    ...common,
    action: z.literal("team"),
    managerEmployeeId: nullableId,
    isActive: z.boolean(),
    members: z
      .array(
        z.object({
          employeeId: z.string().uuid(),
          role: z.enum(["manager", "member"]),
          validFrom: date,
        }),
      )
      .max(500),
  }),
  salesTerritorySchema,
  z
    .strictObject({
      ...common,
      action: z.literal("quota"),
      employeeId: nullableId,
      salesTeamId: nullableId,
      parentQuotaId: nullableId,
      supersedesId: nullableId,
      reason: z.string().max(4000),
      periodStart: date,
      periodEnd: date,
      currency: z.string().regex(/^[A-Z]{3}$/),
      amount: z.string().superRefine((value, ctx) => {
        const parsed = canonicalDecimal(value, 4);
        if (parsed === null)
          ctx.addIssue({
            code: "custom",
            message: moneyRefusal("Quota amount", value),
          });
        else if (
          compareDecimal(parsed, "0") < 0 ||
          parsed.replace(/^[+-]/, "").split(".")[0]!.length > 15
        )
          ctx.addIssue({
            code: "custom",
            message: "Enter a non-negative quota with at most 15 whole digits.",
          });
      }),
      metric: z.enum(["closed_won", "net_invoiced"]),
    })
    .superRefine((v, ctx) => {
      if ((v.employeeId ? 1 : 0) + (v.salesTeamId ? 1 : 0) !== 1)
        ctx.addIssue({
          code: "custom",
          message: "Choose one employee or sales team.",
        });
      if (v.periodEnd < v.periodStart)
        ctx.addIssue({
          code: "custom",
          message: "The end date must not precede the start date.",
        });
    }),
  z.strictObject({
    action: z.literal("quota-transition"),
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    lifecycle: z.enum(["draft", "pending_approval", "approved", "closed"]),
    reason: z.string().trim().min(1).max(4000),
  }),
]);
