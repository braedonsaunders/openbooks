import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { businessToday } from "@openbooks/engine/platform/business-date";
import {
  AllocationRuleError,
  createDraftVersion,
  createRuleWithInitialDraft,
  createDriver,
  createDriverValue,
  deleteDriver,
  deleteDriverValue,
  DriverAdminError,
  DRIVER_SOURCE_KINDS,
  getRuleVersion,
  listDriverValues,
  publishVersion,
  replaceTargets,
  retireVersion,
  updateDraftVersion,
  updateDriver,
  updateDriverValue,
  updateRule,
  type AllocationTargetInput,
} from "@openbooks/engine/allocations/runtime";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by an allocation read.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const REVISION = z
  .string()
  .min(1)
  .max(200)
  .describe("Current revision returned by the matching allocation read.");

function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function settleAllocationRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof AllocationRuleError) {
    const details = {
      code: error.code,
      ...(error.problems ? { problems: error.problems } : {}),
    };
    if (error.code === "NOT_FOUND") throw notFound("allocation record");
    if (error.code === "FROZEN" || error.code === "STALE") throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  if (error instanceof DriverAdminError) {
    const code =
      error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, { code: error.code });
  }
  throw error;
}

function allocationMutation<S extends z.ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  destructive?: boolean;
  unrestricted?: boolean;
  execute: (context: ApplicationContext, input: z.infer<S>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "allocations.manage"),
    featureKey: "allocations",
    execute: async (context, input) => {
      assertApplicationPermission(context, "allocations.manage");
      if (args.unrestricted) assertUnrestricted(context);
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleAllocationRefusal(error);
      }
    },
  });
}

const ACCOUNT_SCOPE = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any").describe("Selects every account.") }).strict(),
  z
    .object({
      kind: z.literal("accounts").describe("Selects specific chart accounts."),
      accountIds: z.array(UUID).max(1000).describe("Source account ids included in the rule."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("account_group").describe("Selects an account group."),
      dimension: z.string().min(1).max(100).describe("Account-group dimension key."),
      groupKey: z.string().min(1).max(100).describe("Account-group key."),
    })
    .strict(),
]);

const DIMENSION_FILTERS = z
  .object({
    departmentIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Department ids included in the source scope."),
    locationIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Location ids included in the source scope."),
    classIds: z.array(UUID).max(500).optional().describe("Class ids included in the source scope."),
    projectIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Project ids included in the source scope."),
    subsidiaryIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Subsidiary ids included in the source scope."),
    partyIds: z.array(UUID).max(500).optional().describe("Party ids included in the source scope."),
    itemIds: z.array(UUID).max(500).optional().describe("Item ids included in the source scope."),
    payComponentIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Payroll component ids included in the source scope."),
    payrollEmployeeIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Employee ids included in the source scope."),
    timeTypeIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Time type ids included in the source scope."),
    payrollExpensesOnly: z
      .boolean()
      .optional()
      .describe("Restrict the source to payroll expenses."),
    extraDims: z
      .record(z.string().max(100), z.array(z.string().max(200)).max(500))
      .optional()
      .describe("Extra dimension values keyed by dimension."),
    requireUntagged: z
      .array(z.enum(["department", "location", "class", "project"]))
      .max(4)
      .optional()
      .describe("Dimensions that must be untagged on source entries."),
  })
  .strict();

const DYNAMIC_TARGET = z
  .object({
    dimension: z
      .string()
      .regex(/^(department|location|class|project|subsidiary|extra:.+)$/)
      .optional()
      .describe("Dimension whose values become targets."),
    include: z
      .array(z.string().max(200))
      .max(500)
      .optional()
      .describe("Optional target values to include."),
    exclude: z.array(z.string().max(200)).max(500).optional().describe("Target values to exclude."),
    minWeight: z
      .string()
      .regex(/^\d+(?:\.\d{1,8})?$/)
      .optional()
      .describe("Minimum exact decimal weight per target."),
    targetAccountId: UUID.nullable()
      .optional()
      .describe("Optional account used by every generated target."),
  })
  .strict();

const ALLOCATION_TARGET = z
  .object({
    sequence: z.number().int().nonnegative().optional().describe("Target ordering index."),
    targetAccountId: UUID.nullable()
      .optional()
      .describe("Target account id, when required by the rule."),
    departmentId: UUID.nullable().optional().describe("Department target id."),
    locationId: UUID.nullable().optional().describe("Location target id."),
    classId: UUID.nullable().optional().describe("Class target id."),
    projectId: UUID.nullable().optional().describe("Project target id."),
    subsidiaryId: UUID.nullable().optional().describe("Subsidiary target id."),
    extraDims: z
      .record(z.string().max(100), z.string().max(200))
      .optional()
      .describe("Extra target dimensions keyed by dimension."),
    fixedPercent: z
      .string()
      .regex(/^\d+(?:\.\d{1,8})?$/)
      .nullable()
      .optional()
      .describe("Exact decimal percent for fixed-share rules."),
    weight: z
      .string()
      .regex(/^\d+(?:\.\d{1,8})?$/)
      .nullable()
      .optional()
      .describe("Exact decimal weight for driver-based rules."),
    isRemainder: z
      .boolean()
      .optional()
      .describe("Whether this target receives the rounding remainder."),
    label: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe("Optional label shown with the target."),
  })
  .strict();

const DRAFT_VERSION_FIELDS = {
  effectiveFrom: DATE.optional().describe("First effective date for the version."),
  effectiveTo: DATE.nullable().optional().describe("Optional final effective date."),
  bookScope: z
    .enum(["primary", "all_posting", "books"])
    .optional()
    .describe("Accounting-book scope."),
  bookIds: z.array(UUID).max(500).optional().describe("Book ids required when bookScope is books."),
  documentKinds: z
    .array(z.string().max(100))
    .max(100)
    .nullable()
    .optional()
    .describe("Document kinds covered by the rule."),
  accountScope: ACCOUNT_SCOPE.optional().describe("Source account selection."),
  dimensionFilters: DIMENSION_FILTERS.optional().describe("Source dimension filters."),
  applyPolicy: z
    .enum(["automatic", "suggest", "manual"])
    .optional()
    .describe("How suggestions are applied."),
  sourceMeasure: z
    .enum(["period_activity", "period_end_balance", "ytd_activity"])
    .optional()
    .describe("Source balance measure."),
  basisKind: z
    .enum(["fixed_percent", "driver", "stepped"])
    .optional()
    .describe("Distribution basis."),
  driverId: UUID.nullable().optional().describe("Allocation driver id for driver-based rules."),
  driverAsOf: z
    .enum(["period", "document_date", "prior_period"])
    .optional()
    .describe("Date used to select driver values."),
  basisConfig: z
    .record(z.string().max(100), z.unknown())
    .optional()
    .describe("Basis-specific exact allocation configuration."),
  targetKind: z
    .enum(["explicit", "dynamic"])
    .optional()
    .describe("Whether targets are explicit or resolved dynamically."),
  dynamicTarget: DYNAMIC_TARGET.optional().describe("Dynamic target selection settings."),
  impact: z
    .enum(["reclass", "net_zero_pair", "report_only"])
    .optional()
    .describe("Accounting impact of the allocation."),
  offsetAccountId: UUID.nullable()
    .optional()
    .describe("Offset account used by reclassification rules."),
  residualPolicy: z
    .enum(["largest_share", "first_target", "last_target", "explicit_target"])
    .optional()
    .describe("Policy for assigning rounding residuals."),
  residualTargetId: UUID.nullable().optional().describe("Explicit target id used for residuals."),
  solveMethod: z
    .enum(["sequential", "simultaneous"])
    .optional()
    .describe("Method for solving interdependent allocations."),
  runPolicy: z
    .enum(["manual", "auto_preview", "auto_post"])
    .optional()
    .describe("Run behavior for this version."),
  runOffsetDays: z.number().int().optional().describe("Days after the period boundary to run."),
  memoTemplate: z.string().max(2000).nullable().optional().describe("Journal memo template."),
  lineDescriptionTemplate: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Journal line description template."),
};

export const LEDGER_ALLOCATION_CONFIGURATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_allocation_driver_values",
    title: "List Allocation Driver Values",
    description:
      "List effective-dated values for one allocation driver. Find the driver with list_allocation_drivers and use these value ids to update or end a value window.",
    inputSchema: z.object({
      driverId: UUID.describe("Allocation driver id from list_allocation_drivers."),
      onDate: DATE.optional().describe("Optional date for filtering effective values."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "allocations.read"),
    featureKey: "allocations",
    execute: async (context, input) => {
      assertApplicationPermission(context, "allocations.read");
      assertUnrestricted(context);
      try {
        const values = await listDriverValues(context.authz.user.orgId, input.driverId, {
          onDate: input.onDate,
        });
        return { ok: true, values, href: `/allocations/drivers/${input.driverId}` };
      } catch (error) {
        settleAllocationRefusal(error);
      }
    },
  }),
  allocationMutation({
    name: "create_allocation_rule",
    title: "Create Allocation Rule",
    description:
      "Create a rule with its first draft version. Use list_allocation_rules to check existing rules; rule setup requires unrestricted subsidiary access.",
    unrestricted: true,
    inputSchema: z.object({
      key: z.string().min(1).max(80).describe("Stable rule key."),
      name: z.string().trim().min(1).max(120).describe("Rule name."),
      description: z
        .string()
        .max(4000)
        .nullable()
        .optional()
        .describe("Optional rule description."),
      mode: z.enum(["entry", "post", "period"]).describe("When the allocation applies."),
      sortOrder: z.number().int().optional().describe("Optional display order."),
      isActive: z.boolean().optional().describe("Whether the rule is available for new work."),
      payrollExpenses: z
        .boolean()
        .optional()
        .describe("Whether this rule allocates payroll expenses."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { created, draft } = await createRuleWithInitialDraft(
        {
          orgId: context.authz.user.orgId,
          key: input.key,
          name: input.name,
          description: input.description,
          mode: input.mode,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          payrollExpenses: input.payrollExpenses,
          effectiveFrom: await businessToday(context.authz.user.orgId),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        { actorId: context.authz.user.id },
      );
      return {
        rule: { ...created.rule, revision: created.revision },
        version: { ...draft.version, revision: draft.revision },
        targets: draft.targets,
        href: "/allocations/rules",
      };
    },
  }),
  allocationMutation({
    name: "update_allocation_rule",
    title: "Update Allocation Rule",
    description:
      "Change a rule's name, description, ordering or active state using its current revision. Read the rule with get_allocation_rule first.",
    inputSchema: z.object({
      ruleId: UUID.describe("Allocation rule id from get_allocation_rule."),
      expectedRevision: REVISION,
      name: z.string().trim().min(1).max(120).optional().describe("Replacement rule name."),
      description: z
        .string()
        .max(4000)
        .nullable()
        .optional()
        .describe("Replacement rule description, or null to clear it."),
      sortOrder: z.number().optional().describe("Replacement display order."),
      isActive: z.boolean().optional().describe("Whether the rule is available for new work."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const updated = await updateRule(
        input.ruleId,
        {
          orgId: context.authz.user.orgId,
          expectedRevision: input.expectedRevision,
          name: input.name,
          description: input.description,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        { actorId: context.authz.user.id },
      );
      return {
        rule: { ...updated.rule, revision: updated.revision },
        href: `/allocations/rules/${input.ruleId}`,
      };
    },
  }),
  allocationMutation({
    name: "create_allocation_rule_version",
    title: "Create Allocation Rule Version",
    description:
      "Create a blank draft version or copy a same-rule version. Find rule and version ids with get_allocation_rule; blank organization-wide drafts require unrestricted subsidiary access.",
    inputSchema: z.object({
      ruleId: UUID.describe("Allocation rule id from get_allocation_rule."),
      fromVersionId: UUID.optional().describe("Optional source version on this same rule."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (!input.fromVersionId) assertUnrestricted(context);
      const created = await createDraftVersion(
        input.ruleId,
        {
          orgId: context.authz.user.orgId,
          fromVersionId: input.fromVersionId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        { actorId: context.authz.user.id },
      );
      return {
        version: { ...created.version, revision: created.revision },
        targets: created.targets,
        href: `/allocations/rules/${input.ruleId}`,
      };
    },
  }),
  allocationMutation({
    name: "update_allocation_rule_version",
    title: "Update Allocation Rule Version",
    description:
      "Edit a draft allocation version with its current revision. Find the version and revision with get_allocation_rule; published and retired versions are immutable.",
    inputSchema: z.object({
      ruleId: UUID.describe("Parent allocation rule id."),
      versionId: UUID.describe("Draft version id from get_allocation_rule."),
      expectedRevision: REVISION,
      ...DRAFT_VERSION_FIELDS,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const current = await getRuleVersion(
        context.authz.user.orgId,
        input.versionId,
        context.authz.allowedSubsidiaryIds,
      );
      if (current.version.ruleId !== input.ruleId) throw notFound("allocation version");
      const { ruleId: _ruleId, versionId, idempotencyKey: _key, ...patch } = input;
      const updated = await updateDraftVersion(
        versionId,
        {
          ...patch,
          orgId: context.authz.user.orgId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        } as Parameters<typeof updateDraftVersion>[1],
        { actorId: context.authz.user.id },
      );
      return {
        version: { ...updated.version, revision: updated.revision },
        href: `/allocations/rules/${input.ruleId}`,
      };
    },
  }),
  allocationMutation({
    name: "replace_allocation_rule_targets",
    title: "Replace Allocation Rule Targets",
    description:
      "Replace every explicit target on a draft allocation version using its current revision. Read the version and existing targets with get_allocation_rule first.",
    inputSchema: z.object({
      ruleId: UUID.describe("Parent allocation rule id."),
      versionId: UUID.describe("Draft version id from get_allocation_rule."),
      expectedRevision: REVISION,
      targets: z
        .array(ALLOCATION_TARGET)
        .min(1)
        .max(1000)
        .describe("Complete ordered target set for this version."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const current = await getRuleVersion(
        context.authz.user.orgId,
        input.versionId,
        context.authz.allowedSubsidiaryIds,
      );
      if (current.version.ruleId !== input.ruleId) throw notFound("allocation version");
      const saved = await replaceTargets(
        input.versionId,
        {
          orgId: context.authz.user.orgId,
          expectedRevision: input.expectedRevision,
          targets: input.targets as AllocationTargetInput[],
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        { actorId: context.authz.user.id },
      );
      return {
        targets: saved.targets,
        revision: saved.revision,
        href: `/allocations/rules/${input.ruleId}`,
      };
    },
  }),
  allocationMutation({
    name: "publish_allocation_rule_version",
    title: "Publish Allocation Rule Version",
    description:
      "Validate and publish a complete draft allocation version. Use get_allocation_rule to confirm the parent rule, targets and current draft state.",
    inputSchema: z.object({
      ruleId: UUID.describe("Parent allocation rule id."),
      versionId: UUID.describe("Draft version id from get_allocation_rule."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const published = await publishVersion(input.versionId, {
        orgId: context.authz.user.orgId,
        expectedRuleId: input.ruleId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      return {
        version: { ...published.version, revision: published.revision },
        targets: published.targets,
        href: `/allocations/rules/${input.ruleId}`,
      };
    },
  }),
  allocationMutation({
    name: "retire_allocation_rule_version",
    title: "Retire Allocation Rule Version",
    description:
      "Retire a published allocation version with an audit reason. Find the version with get_allocation_rule; retired versions cannot be published again.",
    inputSchema: z.object({
      ruleId: UUID.describe("Parent allocation rule id."),
      versionId: UUID.describe("Published version id from get_allocation_rule."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for retiring the version."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const retired = await retireVersion(input.versionId, {
        orgId: context.authz.user.orgId,
        expectedRuleId: input.ruleId,
        actorId: context.authz.user.id,
        reason: input.reason,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      return {
        version: { ...retired.version, revision: retired.revision },
        href: `/allocations/rules/${input.ruleId}`,
      };
    },
  }),
  allocationMutation({
    name: "create_allocation_driver",
    title: "Create Allocation Driver",
    description:
      "Create an allocation driver and its source configuration. Use list_allocation_drivers to check keys and driver ids; the configuration applies organization-wide.",
    unrestricted: true,
    inputSchema: z.object({
      key: z.string().min(1).max(80).describe("Stable driver key."),
      name: z.string().trim().min(1).max(120).describe("Driver name."),
      description: z
        .string()
        .max(4000)
        .nullable()
        .optional()
        .describe("Optional driver description."),
      unit: z.string().max(100).nullable().optional().describe("Optional unit label."),
      dimension: z
        .string()
        .regex(/^(department|location|class|project|subsidiary|extra:.+)$/)
        .describe("Dimension measured by this driver."),
      sourceKind: z.enum(DRIVER_SOURCE_KINDS).describe("Native driver source type."),
      config: z
        .record(z.string().max(100), z.unknown())
        .optional()
        .describe("Source-specific settings validated by the driver service."),
      isActive: z
        .boolean()
        .optional()
        .describe("Whether this driver can be used by allocation rules."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...driver } = input;
      const created = await createDriver(context.authz.user.orgId, context.authz.user.id, driver);
      return { driver: created, href: "/allocations/drivers" };
    },
  }),
  allocationMutation({
    name: "update_allocation_driver",
    title: "Update Allocation Driver",
    description:
      "Change an allocation driver's configuration with the current updatedAt revision. Read the driver with list_allocation_drivers before editing.",
    unrestricted: true,
    inputSchema: z.object({
      driverId: UUID.describe("Driver id from list_allocation_drivers."),
      name: z.string().trim().min(1).max(120).optional().describe("Replacement driver name."),
      description: z
        .string()
        .max(4000)
        .nullable()
        .optional()
        .describe("Replacement description, or null to clear it."),
      unit: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Replacement unit label, or null to clear it."),
      dimension: z
        .string()
        .regex(/^(department|location|class|project|subsidiary|extra:.+)$/)
        .optional()
        .describe("Replacement measured dimension."),
      sourceKind: z
        .enum(DRIVER_SOURCE_KINDS)
        .optional()
        .describe("Replacement native source type."),
      config: z
        .record(z.string().max(100), z.unknown())
        .optional()
        .describe("Replacement source-specific settings."),
      isActive: z.boolean().optional().describe("Whether this driver can be used by rules."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(200)
        .describe("Driver updatedAt value returned by list_allocation_drivers."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { driverId, idempotencyKey: _key, ...patch } = input;
      const driver = await updateDriver(
        context.authz.user.orgId,
        context.authz.user.id,
        driverId,
        patch,
      );
      return { driver, href: `/allocations/drivers/${driverId}` };
    },
  }),
  allocationMutation({
    name: "delete_allocation_driver",
    title: "Delete Allocation Driver",
    description:
      "Delete an allocation driver that is not referenced by a rule or value. Find it with list_allocation_drivers and verify it is unused first.",
    unrestricted: true,
    destructive: true,
    inputSchema: z.object({
      driverId: UUID.describe("Driver id from list_allocation_drivers."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await deleteDriver(context.authz.user.orgId, context.authz.user.id, input.driverId);
      return { ok: true, driverId: input.driverId, href: "/allocations/drivers" };
    },
  }),
  allocationMutation({
    name: "create_allocation_driver_value",
    title: "Create Allocation Driver Value",
    description:
      "Create an effective-dated exact decimal value for a driver dimension. Find the driver with list_allocation_drivers and review existing windows with list_allocation_driver_values.",
    unrestricted: true,
    inputSchema: z.object({
      driverId: UUID.describe("Driver id from list_allocation_drivers."),
      dimensionValueId: UUID.describe("Active dimension value id measured by the driver."),
      effectiveFrom: DATE,
      effectiveTo: DATE.nullable().optional().describe("Optional final effective date."),
      value: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .describe("Exact nonnegative decimal driver value as a string."),
      note: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional note explaining this value."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { driverId, idempotencyKey: _key, ...valueInput } = input;
      const value = await createDriverValue(
        context.authz.user.orgId,
        context.authz.user.id,
        driverId,
        valueInput,
      );
      return { value, href: `/allocations/drivers/${driverId}` };
    },
  }),
  allocationMutation({
    name: "update_allocation_driver_value",
    title: "Update Allocation Driver Value",
    description:
      "Correct a driver's value or close its effective window using the revision returned by list_allocation_driver_values. The original start date is immutable.",
    unrestricted: true,
    inputSchema: z.object({
      valueId: UUID.describe("Driver value id from list_allocation_driver_values."),
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Replacement end date, or null to reopen the window."),
      value: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .optional()
        .describe("Replacement exact nonnegative decimal value as a string."),
      note: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Replacement note, or null to clear it."),
      expectedUpdatedAt: z
        .string()
        .max(200)
        .optional()
        .describe("Current updatedAt revision, when available."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { valueId, idempotencyKey: _key, ...patch } = input;
      const value = await updateDriverValue(
        context.authz.user.orgId,
        context.authz.user.id,
        valueId,
        patch,
      );
      return { value, href: `/allocations/drivers/${value.driverId}` };
    },
  }),
  allocationMutation({
    name: "delete_allocation_driver_value",
    title: "Delete Allocation Driver Value",
    description:
      "Delete an incorrect driver value while preserving its audit history. Find the value with list_allocation_driver_values and provide its exact id.",
    unrestricted: true,
    destructive: true,
    inputSchema: z.object({
      valueId: UUID.describe("Driver value id from list_allocation_driver_values."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await deleteDriverValue(context.authz.user.orgId, context.authz.user.id, input.valueId);
      return { ok: true, valueId: input.valueId, href: "/allocations/drivers" };
    },
  }),
];
