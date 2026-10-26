import { z } from "zod";
import { civilDateInput } from "@/lib/api/civil-date";
import { isUuid } from "../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/benefit-programs/*. The program service
 * owns the full contract (resolvable rules, component links, status moves);
 * the boundary pins the shape it can pin. Amounts are exact decimals, never
 * floats; closing and membership changes always carry a reason.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const civilDate = civilDateInput();
const reason = z.string().trim().min(1, "reason required").max(2000);
const decimal = z.string().trim().min(1).max(64).nullish();
const uuidList = z.array(uuid).max(100).nullish();

const family = z.enum(["reward", "allowance", "incentive", "custom"]);
const delivery = z.enum(["payroll", "external"]);
const valuation = z.enum(["fixed", "percent", "pool", "per_unit"]);
const metric = z
  .enum([
    "revenue",
    "gross_profit",
    "net_profit",
    "approved_hours",
    "transactions",
    "project_margin",
  ])
  .nullish();
const metricScope = z.enum(["company", "department", "project"]).nullish();
const allocation = z.enum(["equal", "hours", "role", "responsibility"]);
const frequency = z.enum(["monthly", "quarterly", "annual", "project_complete", "manual"]);
const periodBasis = z.enum(["calendar", "fiscal"]).nullish();
const unassignedTime = z.enum(["refuse", "exclude"]).optional();

export const createProgramBody = z.strictObject({
  action: z.literal("create"),
  reason: reason.optional(),
  code: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  family,
  description: z.string().trim().max(2000).nullish(),
  legalEntityId: uuid.nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "currency is a 3-letter ISO code in capitals"),
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullish(),
  payComponentId: uuid.nullish(),
  deliveryMethod: delivery.optional(),
  valuation: valuation.optional(),
  metric,
  metricScope,
  scopeIds: uuidList,
  scopeCustomerIds: uuidList,
  scopeDepartmentIds: uuidList,
  unassignedTime,
  scopeExcludedProjectIds: uuidList,
  lossPercentRate: decimal,
  projectProfitCap: decimal,
  projectLossCap: decimal,
  poolRounding: z.enum(["share", "pool"]).optional(),
  includeOpenCommitments: z.boolean().optional(),
  hourClassifications: z
    .array(z.enum(["regular", "overtime", "double_time", "other"]))
    .max(4)
    .optional(),
  eligibility: z.enum(["members", "all_employees"]).optional(),
  allocation: allocation.optional(),
  percentRate: decimal,
  fixedAmount: decimal,
  capAmount: decimal,
  budgetAmount: decimal,
  thresholdAmount: decimal,
  frequency: frequency.optional(),
  periodBasis,
  paymentDelayDays: z.number().int().min(0).max(3650).optional(),
  sourceAccountIds: uuidList,
});

const updateProgramBody = z.strictObject({
  action: z.literal("update"),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
  legalEntityId: uuid.nullish(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "currency is a 3-letter ISO code in capitals")
    .optional(),
  effectiveFrom: civilDate.optional(),
  effectiveTo: civilDate.nullish(),
  payComponentId: uuid.nullish(),
  deliveryMethod: delivery.optional(),
  valuation: valuation.optional(),
  metric,
  metricScope,
  scopeIds: uuidList,
  scopeCustomerIds: uuidList,
  scopeDepartmentIds: uuidList,
  unassignedTime,
  scopeExcludedProjectIds: uuidList,
  lossPercentRate: decimal,
  projectProfitCap: decimal,
  projectLossCap: decimal,
  poolRounding: z.enum(["share", "pool"]).optional(),
  includeOpenCommitments: z.boolean().optional(),
  hourClassifications: z
    .array(z.enum(["regular", "overtime", "double_time", "other"]))
    .max(4)
    .optional(),
  eligibility: z.enum(["members", "all_employees"]).optional(),
  allocation: allocation.optional(),
  percentRate: decimal,
  fixedAmount: decimal,
  capAmount: decimal,
  budgetAmount: decimal,
  thresholdAmount: decimal,
  frequency: frequency.optional(),
  periodBasis,
  paymentDelayDays: z.number().int().min(0).max(3650).optional(),
  sourceAccountIds: uuidList,
  reason,
  /** Civil date an active program's revision applies from; earlier periods keep prior terms. */
  changeEffectiveFrom: civilDate.optional(),
});

const activateProgramBody = z.object({
  action: z.literal("activate"),
  reason: reason.optional(),
});
const closeProgramBody = z.object({ action: z.literal("close"), reason });
export const addMemberBody = z.object({
  action: z.literal("addMember"),
  reason: reason.optional(),
  employmentId: uuid,
  effectiveFrom: civilDate,
  effectiveTo: civilDate.nullish(),
  weight: decimal,
  role: z.string().trim().max(120).nullish(),
  excluded: z.boolean().optional(),
});
const removeMemberBody = z.object({
  action: z.literal("removeMember"),
  membershipId: uuid,
  reason,
});

export const benefitProgramPostBody = z.discriminatedUnion("action", [
  createProgramBody,
  updateProgramBody,
  activateProgramBody,
  closeProgramBody,
  addMemberBody,
  removeMemberBody,
]);

export const benefitProgramPatchBody = z.discriminatedUnion("action", [
  updateProgramBody.omit({ action: true }).extend({ action: z.literal("update") }),
  activateProgramBody,
  closeProgramBody,
]);
