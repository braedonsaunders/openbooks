import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/crm/sales/contracts";
import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import { moneyRefusal } from "../payroll-decimal-refusal";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isIsoCalendarDate, "Enter a valid calendar date.")
  .describe("Valid YYYY-MM-DD calendar date.");
const nullableId = uuidString()
  .nullable()
  .describe("Organization-owned UUID, or null to clear it.");
const position = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .describe("Longitude and latitude coordinate pair.");
const ring = z.array(position).min(4).max(200000).describe("Closed polygon boundary coordinates.");
const geometry = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("Polygon").describe("Polygon geometry type."),
      coordinates: z.array(ring).min(1).max(1000).describe("Polygon boundary rings."),
    }),
    z.object({
      type: z.literal("MultiPolygon").describe("MultiPolygon geometry type."),
      coordinates: z
        .array(z.array(ring).min(1).max(1000).describe("Rings in one polygon."))
        .min(1)
        .max(1000)
        .describe("Polygon coordinate groups."),
    }),
  ])
  .describe("Territory boundary geometry.");
const boundary = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .describe("ISO 3166-1 alpha-3 country code."),
    level: z.enum(["ADM0", "ADM1", "ADM2"]).describe("Administrative boundary level."),
    id: z.string().min(1).max(200).describe("Stable boundary identifier."),
    name: z.string().min(1).max(200).describe("Boundary display name."),
    version: z.string().min(1).max(200).describe("Source boundary dataset version."),
    geometry: geometry
      .optional()
      .default({ type: "Polygon", coordinates: [] })
      .describe("Optional custom geometry for the administrative area."),
  })
  .describe("One included or excluded administrative boundary.");
export const salesGeographySchema = z
  .object({
    version: z.literal(1).describe("Geography schema version."),
    includes: z.array(boundary).max(200).describe("Administrative areas included in coverage."),
    excludes: z.array(boundary).max(200).describe("Administrative areas excluded from coverage."),
    polygons: z
      .array(
        z.object({
          id: z.string().max(200).describe("Stable polygon identifier."),
          name: z.string().max(200).describe("Polygon display name."),
          geometry: geometry.describe("Drawn territory polygon."),
        }),
      )
      .max(20)
      .describe("Drawn coverage polygons."),
  })
  .describe("Versioned sales territory geography.");
const common = {
  id: uuidString().optional().describe("Existing record UUID for a revision; omit to create."),
  expectedRevision: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Current record revision for edits."),
  name: z.string().trim().min(1).max(200).describe("Sales record name."),
  subsidiaryId: uuidString().describe("Legal entity that owns this sales record."),
};
const rule = z
  .object({
    field: z
      .enum([
        "country",
        "region",
        "industry",
        "lifecycleStage",
        "leadSourceId",
        "annualRevenue",
        "employeeCount",
      ])
      .describe("Account attribute used to match the territory."),
    operator: z
      .enum(["equals", "in", "contains", "gte", "lte"])
      .describe("Comparison applied to the attribute."),
    value: z
      .union([
        z.string().max(200).describe("Single comparison value."),
        z.array(z.string().max(200)).max(100).describe("Values for an in comparison."),
        z.number().describe("Numeric comparison value."),
      ])
      .describe("Value compared with the selected account attribute."),
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
  })
  .describe("One territory account-matching rule.");
export const salesTerritorySchema = z
  .strictObject({
    ...common,
    action: z.literal("territory").describe("Save a sales territory."),
    managerEmployeeId: nullableId.describe("Territory manager employee party."),
    defaultEmployeeId: nullableId.describe("Default sales representative employee party."),
    salesTeamId: nullableId.describe("Sales team assigned to this territory."),
    description: z.string().max(4000).describe("Territory purpose and coverage notes."),
    priority: z
      .number()
      .int()
      .min(0)
      .max(2147483647)
      .describe("Territory matching priority; lower values are evaluated first."),
    rules: z.array(rule).max(50).describe("Rules that select accounts for this territory."),
    matchMode: z.enum(["all", "any"]).describe("Whether every rule or any rule must match."),
    geography: salesGeographySchema.describe("Administrative and drawn geographic coverage."),
    effectiveFrom: date.describe("Calendar date when this territory becomes effective."),
    lifecycle: z.enum(["draft", "active", "archived"]).describe("Territory lifecycle state."),
    previewRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe("Expected preview digest required when activating changed coverage."),
  })
  .describe("Create or revise a sales territory.");
export const salesCommandSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      action: z.literal("representative").describe("Enable or disable a representative."),
      employeeId: uuidString().describe("Employee party assigned as representative."),
      enabled: z.boolean().describe("Whether the representative is active."),
      since: date.describe("Effective calendar date for this representative change."),
      expectedRevision: z.string().min(1).max(200).describe("Current representative revision."),
    }),
    z.strictObject({
      ...common,
      action: z.literal("team").describe("Create or revise a sales team."),
      managerEmployeeId: nullableId.describe("Team manager employee party."),
      isActive: z.boolean().describe("Whether the sales team is active."),
      members: z
        .array(
          z.object({
            employeeId: uuidString().describe("Employee party in the sales team."),
            role: z.enum(["manager", "member"]).describe("Team membership role."),
            validFrom: date.describe("Date this membership becomes effective."),
          }),
        )
        .max(500)
        .describe("Effective-dated sales team members."),
    }),
    salesTerritorySchema,
    z
      .strictObject({
        ...common,
        action: z.literal("quota").describe("Create or revise a sales quota."),
        employeeId: nullableId.describe(
          "Employee assigned to the quota, or null for a team quota.",
        ),
        salesTeamId: nullableId.describe(
          "Sales team assigned to the quota, or null for an employee quota.",
        ),
        parentQuotaId: nullableId.describe("Parent quota UUID for a child allocation."),
        supersedesId: nullableId.describe("Prior quota UUID replaced by this quota."),
        reason: z.string().max(4000).describe("Reason for this quota change."),
        periodStart: date.describe("First calendar date in the quota period."),
        periodEnd: date.describe("Last calendar date in the quota period."),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .describe("ISO 4217 currency code."),
        amount: z
          .string()
          .max(40)
          .superRefine((value, ctx) => {
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
          })
          .describe("Exact decimal quota amount."),
        metric: z
          .enum(["closed_won", "net_invoiced"])
          .describe("Measure compared with this quota."),
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
      action: z
        .literal("quota-transition")
        .describe("Move a quota through its approval lifecycle."),
      id: uuidString().describe("Quota UUID."),
      expectedRevision: z.number().int().positive().describe("Current quota revision."),
      lifecycle: z
        .enum(["draft", "pending_approval", "closed"])
        .describe("Target quota lifecycle state."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(4000)
        .describe("Reason recorded with the lifecycle change."),
    }),
  ])
  .describe("Native sales representative, team, territory or quota command.");
