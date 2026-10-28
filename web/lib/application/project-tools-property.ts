import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  PropertyManagementError,
  activatePropertyLease,
  addLeaseCharge,
  addLeaseEscalation,
  applyLeaseEscalation,
  assessLeaseLateFees,
  billCamReconciliation,
  billDueLeaseCharges,
  cancelCamPool,
  cancelPropertyLease,
  createCamPool,
  createManagedProperty,
  createPropertyLease,
  createPropertyUnit,
  deleteManagedProperty,
  deletePropertyUnit,
  finalizeCamPool,
  levelLeaseRentStraightLine,
  propertyManagementWorkspace,
  recordSecurityDeposit,
  reopenFinalizedCamPool,
  reverseSecurityDepositTransaction,
  scheduleLeaseCharges,
  terminatePropertyLease,
  updateCamPool,
  updateManagedProperty,
  updatePropertyLease,
  updatePropertyUnit,
} from "@openbooks/engine/property/management";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { findUnownedCustomReferences, loadFieldDefs, validateCustomValues } from "../custom-fields";
import { canonicalDecimal } from "../exact-decimal";
import { normalizeMoney } from "@openbooks/engine/money/money";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by the property-management workspace.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const OPTIONAL_DATE = DATE.nullable()
  .optional()
  .describe("Calendar date in YYYY-MM-DD format, or null.");
const MONEY = z
  .string()
  .max(40)
  .describe("Exact decimal amount as text; never pass a floating-point number.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const CUSTOM_FIELD_VALUES = z
  .record(
    z.string().max(200),
    z.union([
      z.string().max(5000),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.string().max(200)).max(500),
    ]),
  )
  .optional()
  .describe("Custom field values keyed by their Setup field keys.");
const canArRead = (authz: Authz) => can(authz, "ar.read");

async function requirePropertyManagement(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "propertyManagement"))) {
    throw notFound("property-management record");
  }
}

function settlePropertyError(error: unknown): never {
  if (error instanceof ScopeNotFoundError) throw notFound("property-management record");
  if (error instanceof PropertyManagementError) {
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  throw error;
}

async function workspace(context: ApplicationContext) {
  return propertyManagementWorkspace(context.authz.user.orgId, context.authz.allowedSubsidiaryIds);
}

type WriteArgs<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permission: "ar.create" | "gl.post";
  destructive?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
};

function propertyWrite<T extends z.ZodTypeAny>(args: WriteArgs<T>): ApplicationToolDefinition {
  const { permission, ...metadata } = args;
  return definition({
    ...metadata,
    inputSchema: metadata.inputSchema,
    readOnly: false,
    destructive: metadata.destructive ?? false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, permission),
    featureKey: "propertyManagement",
    execute: async (context, input) => {
      assertApplicationPermission(context, permission);
      await requirePropertyManagement(context);
      try {
        return await args.execute(context, input);
      } catch (error) {
        settlePropertyError(error);
      }
    },
  });
}

function common(context: ApplicationContext) {
  return {
    orgId: context.authz.user.orgId,
    actorId: context.authz.user.id,
    allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
  };
}

function normalizedMoney(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const parsed = canonicalDecimal(value, 4);
  if (parsed === null) throw invalidInput("Amount must be an exact decimal string");
  return normalizeMoney(parsed);
}

async function cleanPropertyCustomValues(
  orgId: string,
  values: Record<string, unknown> | undefined,
) {
  const definitions = await loadFieldDefs("managed_properties");
  const validation = validateCustomValues(definitions, values);
  if (!validation.ok)
    throw invalidInput(Object.values(validation.errors)[0] ?? "Invalid custom fields");
  const foreignReferences = await findUnownedCustomReferences(
    orgId,
    definitions,
    validation.cleaned,
  );
  if (foreignReferences.length) {
    throw notFound(foreignReferences[0]!.label);
  }
  return validation.cleaned;
}

export const PROJECT_PROPERTY_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_property_management_workspace",
    title: "Get Property Management Workspace",
    description:
      "Read properties, units, leases, tenants, rent charges, CAM pools, deposits, and billing status in your subsidiary scope. Use this to find property-management record ids before taking an action.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canArRead,
    featureKey: "propertyManagement",
    execute: async (context) => {
      assertApplicationPermission(context, "ar.read");
      await requirePropertyManagement(context);
      try {
        return { ok: true, workspace: await workspace(context), href: "/property-management" };
      } catch (error) {
        settlePropertyError(error);
      }
    },
  }),
  propertyWrite({
    name: "create_managed_property",
    title: "Create Managed Property",
    description:
      "Create a managed property with its legal entity, property type, accounting defaults, and optional custom fields. Find legal entities, accounts, and locations with setup reads; verify it with get_property_management_workspace.",
    permission: "ar.create",
    inputSchema: z.object({
      subsidiaryId: UUID.describe("Owning legal entity id."),
      code: z.string().trim().min(1).max(80).describe("Unique property code."),
      name: z.string().trim().min(1).max(200).describe("Property name."),
      propertyType: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("Project Type engine property type key."),
      locationId: UUID.nullable().optional().describe("Optional property location."),
      fixedAssetId: UUID.nullable().optional().describe("Optional linked fixed asset."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional()
        .describe("Optional ISO currency code."),
      address: z.record(z.string(), z.string()).optional().describe("Property address fields."),
      rentIncomeAccountId: UUID.nullable().optional().describe("Optional rent income account."),
      camIncomeAccountId: UUID.nullable().optional().describe("Optional CAM income account."),
      depositLiabilityAccountId: UUID.nullable()
        .optional()
        .describe("Optional deposit liability account."),
      defaultBankAccountId: UUID.nullable().optional().describe("Optional deposit bank account."),
      custom: CUSTOM_FIELD_VALUES,
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const custom = await cleanPropertyCustomValues(context.authz.user.orgId, input.custom);
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await createManagedProperty({
          ...body,
          custom,
          ...common(context),
        } as never);
        return { ok: true, ...(result as object), href: "/property-management" };
      } catch (error) {
        settlePropertyError(error);
      }
    },
  }),
  propertyWrite({
    name: "update_managed_property",
    title: "Update Managed Property",
    description:
      "Update a managed property's identity, legal entity, accounting defaults, status, and custom fields. Find the property with get_property_management_workspace and include the full property values required by the native update.",
    permission: "ar.create",
    inputSchema: z.object({
      propertyId: UUID.describe("Managed property id."),
      subsidiaryId: UUID.describe("Owning legal entity id."),
      code: z.string().trim().min(1).max(80).describe("Property code."),
      name: z.string().trim().min(1).max(200).describe("Property name."),
      propertyType: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("Project Type engine property type key."),
      status: z.enum(["active", "inactive"]).describe("Property status."),
      locationId: UUID.nullable().optional().describe("Optional property location."),
      fixedAssetId: UUID.nullable().optional().describe("Optional linked fixed asset."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional()
        .describe("Optional ISO currency code."),
      address: z.record(z.string(), z.string()).optional().describe("Property address fields."),
      rentIncomeAccountId: UUID.nullable().optional().describe("Optional rent income account."),
      camIncomeAccountId: UUID.nullable().optional().describe("Optional CAM income account."),
      depositLiabilityAccountId: UUID.nullable()
        .optional()
        .describe("Optional deposit liability account."),
      defaultBankAccountId: UUID.nullable().optional().describe("Optional deposit bank account."),
      custom: CUSTOM_FIELD_VALUES,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .nullable()
        .optional()
        .describe("Reason for material property changes."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const custom = await cleanPropertyCustomValues(context.authz.user.orgId, input.custom);
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await updateManagedProperty({
          ...body,
          custom,
          ...common(context),
        } as never);
        return { ok: true, ...(result as object), href: "/property-management" };
      } catch (error) {
        settlePropertyError(error);
      }
    },
  }),
  propertyWrite({
    name: "delete_managed_property",
    title: "Delete Managed Property",
    description:
      "Delete an unused managed property. Find its id with get_property_management_workspace; the native service refuses properties with dependent records.",
    permission: "ar.create",
    destructive: true,
    inputSchema: z.object({
      propertyId: UUID.describe("Managed property id."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      await deleteManagedProperty(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.propertyId,
      );
      return { ok: true, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "create_property_unit",
    title: "Create Property Unit",
    description:
      "Create a rentable unit under a managed property. Find the property id with get_property_management_workspace; verify the unit there.",
    permission: "ar.create",
    inputSchema: z.object({
      propertyId: UUID.describe("Parent property id."),
      code: z.string().trim().min(1).max(80).describe("Unit code."),
      name: z.string().trim().max(200).nullable().optional().describe("Optional unit name."),
      unitType: z.string().trim().max(80).nullable().optional().describe("Optional unit type."),
      rentableArea: MONEY.nullable().optional().describe("Exact rentable area as decimal text."),
      bedrooms: z.number().int().min(0).max(100).nullable().optional().describe("Bedroom count."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const result = await createPropertyUnit({
        ...body,
        rentableArea: normalizedMoney(input.rentableArea),
        ...common(context),
      } as never);
      return { ok: true, ...(result as object), href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "update_property_unit",
    title: "Update Property Unit",
    description:
      "Update a property's unit details and occupancy status. Find the unit with get_property_management_workspace; a reason is required for governed status changes.",
    permission: "ar.create",
    inputSchema: z.object({
      unitId: UUID.describe("Property unit id."),
      code: z.string().trim().min(1).max(80).describe("Unit code."),
      name: z.string().trim().max(200).nullable().optional().describe("Optional unit name."),
      unitType: z.string().trim().max(80).nullable().optional().describe("Optional unit type."),
      rentableArea: MONEY.nullable().optional().describe("Exact rentable area as decimal text."),
      bedrooms: z.number().int().min(0).max(100).nullable().optional().describe("Bedroom count."),
      status: z
        .enum(["vacant", "occupied", "notice", "offline"])
        .optional()
        .describe("Unit availability status."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .nullable()
        .optional()
        .describe("Reason for a governed status change."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const result = await updatePropertyUnit({
        ...body,
        rentableArea: normalizedMoney(input.rentableArea),
        ...common(context),
      } as never);
      return { ok: true, ...(result as object), href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "delete_property_unit",
    title: "Delete Property Unit",
    description:
      "Delete an unused property unit. Find its id with get_property_management_workspace; the native service refuses units with dependent records.",
    permission: "ar.create",
    destructive: true,
    inputSchema: z.object({ unitId: UUID.describe("Property unit id."), idempotencyKey: KEY }),
    execute: async (context, input) => {
      await deletePropertyUnit(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.unitId,
      );
      return { ok: true, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "create_property_lease",
    title: "Create Property Lease",
    description:
      "Create a draft lease for an active property, unit, and customer tenant. Find property, unit, and tenant ids with get_property_management_workspace; verify the lease there.",
    permission: "ar.create",
    inputSchema: z.object({
      propertyId: UUID,
      unitId: UUID.nullable().optional().describe("Optional unit assigned to this lease."),
      tenantId: UUID,
      leaseNumber: z.string().trim().min(1).max(80).describe("Unique lease number."),
      startsOn: DATE,
      endsOn: OPTIONAL_DATE,
      baseRent: MONEY,
      billingDay: z
        .number()
        .int()
        .min(1)
        .max(31)
        .optional()
        .describe("Day of month for rent billing; defaults to the service policy."),
      paymentTermsDays: z
        .number()
        .int()
        .min(0)
        .max(365)
        .optional()
        .describe("Invoice payment terms in whole days."),
      securityDepositRequired: MONEY.nullable()
        .optional()
        .describe("Exact security deposit amount, or null for zero."),
      camMethod: z
        .enum(["none", "fixed", "pro_rata"])
        .optional()
        .describe("Lease CAM allocation method."),
      camSharePercent: MONEY.nullable()
        .optional()
        .describe("Lease CAM share percentage as exact decimal text."),
      lateFeeType: z
        .enum(["none", "fixed", "percent"])
        .optional()
        .describe("Late-fee calculation method."),
      lateFeeValue: MONEY.nullable()
        .optional()
        .describe("Fixed amount or percentage for late fees."),
      graceDays: z
        .number()
        .int()
        .min(0)
        .max(365)
        .optional()
        .describe("Whole days after due date before late-fee assessment."),
      autoInvoice: z
        .boolean()
        .optional()
        .describe("Whether scheduled rent generates invoices automatically."),
      autoPost: z
        .boolean()
        .optional()
        .describe("Whether scheduled rent invoices post automatically."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await createPropertyLease({
        ...common(context),
        ...data,
        securityDepositRequired: data.securityDepositRequired ?? undefined,
        lateFeeValue: data.lateFeeValue ?? undefined,
        requestId: context.requestId,
      });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "activate_property_lease",
    title: "Activate Property Lease",
    description:
      "Activate a valid draft lease after confirming its property, unit, dates, rent, and tenant. Find the lease with get_property_management_workspace and verify its active state there.",
    permission: "ar.create",
    inputSchema: z.object({ leaseId: UUID, idempotencyKey: KEY }),
    execute: async (context, input) => {
      const result = await activatePropertyLease(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.leaseId,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "update_property_lease",
    title: "Update Property Lease",
    description:
      "Update a lease's tenant, terms, dates, rent, and billing policy. Find the lease with get_property_management_workspace and provide the full current values required by the native lease update.",
    permission: "ar.create",
    inputSchema: z.object({
      leaseId: UUID.describe("Lease id."),
      propertyId: UUID.describe("Managed property id."),
      unitId: UUID.nullable().optional().describe("Unit id, or null for no assigned unit."),
      tenantId: UUID.describe("Customer party id for the tenant."),
      leaseNumber: z.string().trim().min(1).max(80).describe("Lease number."),
      startsOn: DATE,
      endsOn: OPTIONAL_DATE,
      baseRent: MONEY,
      billingDay: z.number().int().min(1).max(31).describe("Day of month rent is due."),
      paymentTermsDays: z.number().int().min(0).max(365).describe("Invoice payment terms in days."),
      securityDepositRequired: MONEY.describe("Exact required security deposit amount."),
      camMethod: z.enum(["none", "fixed", "pro_rata"]).describe("Lease CAM method."),
      camSharePercent: MONEY.nullable().optional().describe("Exact decimal CAM share percentage."),
      lateFeeType: z.enum(["none", "fixed", "percent"]).describe("Late-fee calculation method."),
      lateFeeValue: MONEY.describe("Exact late-fee amount or percentage."),
      graceDays: z
        .number()
        .int()
        .min(0)
        .max(365)
        .describe("Days after due date before a late fee."),
      autoInvoice: z.boolean().describe("Whether scheduled rent automatically creates invoices."),
      autoPost: z.boolean().describe("Whether scheduled rent invoices automatically post."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await updatePropertyLease({
        ...common(context),
        ...data,
        requestId: context.requestId,
      });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "cancel_property_lease",
    title: "Cancel Property Lease",
    description:
      "Cancel a lease that has not started or been billed, subject to native lease controls. Find its id with get_property_management_workspace.",
    permission: "ar.create",
    destructive: true,
    inputSchema: z.object({ leaseId: UUID, idempotencyKey: KEY }),
    execute: async (context, input) => {
      await cancelPropertyLease(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.leaseId,
      );
      return { ok: true, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "terminate_property_lease",
    title: "Terminate Property Lease",
    description:
      "Terminate an active lease on a stated date with an audit reason. Find the lease with get_property_management_workspace; termination follows the native notice and billing controls.",
    permission: "ar.create",
    destructive: true,
    inputSchema: z.object({
      leaseId: UUID,
      terminatedOn: DATE,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason recorded in the lease audit history."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      await terminatePropertyLease(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.leaseId,
        input.terminatedOn,
        input.reason,
      );
      return { ok: true, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "add_property_lease_charge",
    title: "Add Property Lease Charge",
    description:
      "Add a recurring or one-time rent charge to an active lease with exact amount and effective dates. Find the lease with get_property_management_workspace; verify the new charge there.",
    permission: "ar.create",
    inputSchema: z.object({
      leaseId: UUID,
      chargeType: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("Charge category, such as base rent or utility recovery."),
      description: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Description shown on the rent invoice."),
      amount: MONEY,
      frequency: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .describe("Native billing frequency for this charge."),
      effectiveFrom: DATE,
      effectiveTo: OPTIONAL_DATE,
      incomeAccountId: UUID.nullable().optional().describe("Optional income account override."),
      itemId: UUID.nullable().optional().describe("Optional charge item for invoice generation."),
      taxCodeId: UUID.nullable().optional().describe("Optional tax code for invoice generation."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await addLeaseCharge({
        ...common(context),
        ...data,
        requestId: context.requestId,
      });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "add_property_lease_escalation",
    title: "Add Property Lease Escalation",
    description:
      "Record a future rent increase by percentage, fixed amount, or new rent amount. Find the lease with get_property_management_workspace; apply the escalation when its effective date arrives.",
    permission: "ar.create",
    inputSchema: z.object({
      leaseId: UUID,
      effectiveOn: DATE,
      method: z
        .enum(["percent", "fixed", "new_amount"])
        .describe("How the rent escalation changes current rent."),
      value: MONEY,
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await addLeaseEscalation({ ...common(context), ...data });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "apply_property_lease_escalation",
    title: "Apply Property Lease Escalation",
    description:
      "Apply a due escalation to its lease's future rent charges. Find escalation ids and effective dates with get_property_management_workspace.",
    permission: "ar.create",
    inputSchema: z.object({ escalationId: UUID, idempotencyKey: KEY }),
    execute: async (context, input) => {
      const result = await applyLeaseEscalation(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.escalationId,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "schedule_property_lease_charges",
    title: "Schedule Property Lease Charges",
    description:
      "Generate due rent-charge schedule rows for a lease through an optional date. Find the lease with get_property_management_workspace and verify scheduled periods there.",
    permission: "ar.create",
    inputSchema: z.object({ leaseId: UUID, throughOn: OPTIONAL_DATE, idempotencyKey: KEY }),
    execute: async (context, input) => {
      const result = await scheduleLeaseCharges(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.leaseId,
        input.throughOn ?? undefined,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "bill_property_rent",
    title: "Bill Property Rent",
    description:
      "Generate rent invoices due on a stated date for one lease or a property. Use get_property_management_workspace to find ids; bulk portfolio billing requires unrestricted subsidiary access.",
    permission: "ar.create",
    inputSchema: z.object({
      asOf: OPTIONAL_DATE,
      leaseId: UUID.nullable()
        .optional()
        .describe("Limit billing to one lease, or null for property-level billing."),
      propertyId: UUID.nullable()
        .optional()
        .describe("Limit billing to one property; omit only with unrestricted scope."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      if (context.authz.allowedSubsidiaryIds !== null && !input.leaseId && !input.propertyId)
        throw forbidden("subsidiary.restricted");
      const result = await billDueLeaseCharges(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.asOf ?? undefined,
        input.leaseId ?? undefined,
        input.propertyId ?? undefined,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "assess_property_late_fees",
    title: "Assess Property Late Fees",
    description:
      "Assess late fees due for a lease or property through a stated date. Find ids with get_property_management_workspace; bulk portfolio assessment requires unrestricted subsidiary access.",
    permission: "ar.create",
    inputSchema: z.object({
      asOf: OPTIONAL_DATE,
      leaseId: UUID.nullable()
        .optional()
        .describe("Limit assessment to one lease, or null for property-level assessment."),
      propertyId: UUID.nullable()
        .optional()
        .describe("Limit assessment to one property; omit only with unrestricted scope."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      if (context.authz.allowedSubsidiaryIds !== null && !input.leaseId && !input.propertyId)
        throw forbidden("subsidiary.restricted");
      const result = await assessLeaseLateFees(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.asOf ?? undefined,
        input.leaseId ?? undefined,
        input.propertyId ?? undefined,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "level_property_rent",
    title: "Level Property Rent",
    description:
      "Generate straight-line rent recognition entries for an individual lease. Find its id with get_property_management_workspace; the route requires GL posting permission.",
    permission: "gl.post",
    inputSchema: z.object({
      asOf: OPTIONAL_DATE,
      leaseId: UUID.nullable()
        .optional()
        .describe("Lease to level; required when subsidiary access is restricted."),
      propertyId: UUID.nullable().optional().describe("Property filter for the lease selection."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      if (context.authz.allowedSubsidiaryIds !== null && !input.leaseId && !input.propertyId)
        throw forbidden("subsidiary.restricted");
      if (input.propertyId && !input.leaseId)
        throw invalidInput("Rent leveling scopes by lease; pass leaseId without propertyId.");
      const result = await levelLeaseRentStraightLine(
        context.authz.user.orgId,
        context.authz.user.id,
        {
          asOf: input.asOf ?? (await businessToday(context.authz.user.orgId)),
          onlyLeaseId: input.leaseId ?? undefined,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
      );
      return { ok: true, results: result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "record_property_security_deposit",
    title: "Record Property Security Deposit",
    description:
      "Record a received, applied, refunded, interest, or adjustment transaction against a lease deposit, with the native accounting and audit controls. Find lease ids with get_property_management_workspace.",
    permission: "gl.post",
    inputSchema: z.object({
      leaseId: UUID,
      kind: z
        .enum([
          "received",
          "interest",
          "applied",
          "refunded",
          "adjustment_increase",
          "adjustment_decrease",
        ])
        .describe("Security-deposit transaction kind."),
      occurredOn: DATE,
      amount: MONEY,
      bankAccountId: UUID.nullable()
        .optional()
        .describe("Bank account for the deposit receipt, when applicable."),
      offsetAccountId: UUID.nullable()
        .optional()
        .describe("Offset account for the transaction, when applicable."),
      appliedDocumentId: UUID.nullable()
        .optional()
        .describe("Invoice document id when applying a deposit."),
      memo: z.string().max(500).nullable().optional().describe("Optional transaction memo."),
      importKey: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Stable import key for an externally imported deposit."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await recordSecurityDeposit({
        ...common(context),
        ...data,
      });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "reverse_property_security_deposit",
    title: "Reverse Property Security Deposit",
    description:
      "Reverse a deposit transaction using a new dated compensating event and audit reason; posted history remains immutable. Find the transaction id with get_property_management_workspace.",
    permission: "gl.post",
    destructive: true,
    inputSchema: z.object({
      transactionId: UUID,
      occurredOn: DATE,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason for the compensating deposit transaction."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const result = await reverseSecurityDepositTransaction({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        transactionId: input.transactionId,
        occurredOn: input.occurredOn,
        reason: input.reason,
      });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "create_property_cam_pool",
    title: "Create Property CAM Pool",
    description:
      "Create a common-area maintenance pool for an active property and defined fiscal period. Find property and expense-account ids with native reads; verify the pool with get_property_management_workspace.",
    permission: "ar.create",
    inputSchema: z.object({
      propertyId: UUID,
      name: z.string().trim().min(1).max(200).describe("CAM pool name."),
      fiscalYear: z.number().int().min(1900).max(2200).describe("Fiscal year for the pool."),
      periodStartsOn: DATE,
      periodEndsOn: DATE,
      allocationBasis: z
        .enum(["rentable_area", "equal", "custom"])
        .describe("CAM allocation basis."),
      vacancyTreatment: z
        .enum(["occupied_area", "total_rentable_area"])
        .optional()
        .describe("Policy for allocating the vacant share of a pool."),
      budgetAmount: MONEY,
      expenseAccountIds: z
        .array(UUID)
        .min(1)
        .max(500)
        .describe("Active posting expense accounts included in the CAM pool."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await createCamPool({ ...common(context), ...data });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "update_property_cam_pool",
    title: "Update Property CAM Pool",
    description:
      "Update an open CAM pool's period, allocation, budget, and expense accounts before finalization. Find the pool id with get_property_management_workspace.",
    permission: "ar.create",
    inputSchema: z.object({
      poolId: UUID,
      name: z.string().trim().min(1).max(200).describe("CAM pool name."),
      fiscalYear: z.number().int().min(1900).max(2200).describe("Fiscal year for the pool."),
      periodStartsOn: DATE,
      periodEndsOn: DATE,
      allocationBasis: z
        .enum(["rentable_area", "equal", "custom"])
        .describe("CAM allocation basis."),
      vacancyTreatment: z
        .enum(["occupied_area", "total_rentable_area"])
        .optional()
        .describe("Policy for the vacant share of a pool."),
      budgetAmount: MONEY,
      expenseAccountIds: z
        .array(UUID)
        .min(1)
        .max(500)
        .describe("Active posting expense accounts included in the pool."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...data } = input;
      const result = await updateCamPool({ ...common(context), ...data });
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "cancel_property_cam_pool",
    title: "Cancel Property CAM Pool",
    description:
      "Cancel an open CAM pool before it is finalized or billed. Find the pool id with get_property_management_workspace.",
    permission: "ar.create",
    destructive: true,
    inputSchema: z.object({ poolId: UUID, idempotencyKey: KEY }),
    execute: async (context, input) => {
      await cancelCamPool(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.poolId,
      );
      return { ok: true, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "reopen_property_cam_pool",
    title: "Reopen Property CAM Pool",
    description:
      "Reopen a finalized CAM pool with a recorded reason when corrections are needed before billing. Find its id with get_property_management_workspace.",
    permission: "gl.post",
    destructive: true,
    inputSchema: z.object({
      poolId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason for reopening the finalized pool."),
      idempotencyKey: KEY,
    }),
    execute: async (context, input) => {
      await reopenFinalizedCamPool(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.poolId,
        input.reason,
      );
      return { ok: true, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "finalize_property_cam_pool",
    title: "Finalize Property CAM Pool",
    description:
      "Finalize CAM allocations for an open pool, creating its governed tenant allocation results. Find the pool with get_property_management_workspace and verify finalized allocations there.",
    permission: "gl.post",
    inputSchema: z.object({ poolId: UUID, idempotencyKey: KEY }),
    execute: async (context, input) => {
      const result = await finalizeCamPool(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.poolId,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
  propertyWrite({
    name: "bill_property_cam_pool",
    title: "Bill Property CAM Pool",
    description:
      "Generate tenant invoices from a finalized CAM pool for the chosen invoice date. Find pool and invoice ids with get_property_management_workspace.",
    permission: "ar.create",
    inputSchema: z.object({ poolId: UUID, invoiceDate: OPTIONAL_DATE, idempotencyKey: KEY }),
    execute: async (context, input) => {
      const result = await billCamReconciliation(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input.poolId,
        input.invoiceDate ?? undefined,
      );
      return { ok: true, ...result, href: "/property-management" };
    },
  }),
];
