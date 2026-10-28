import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { type ApplicationToolDefinition } from "./tool-definition";
import { timeDefinition } from "./time-tool-common";
import { invalidInput } from "./errors";
import {
  createDemandLine,
  deleteDemandLine,
  updateDemandLine,
} from "@openbooks/engine/resourcing/demand-lines";
import {
  deleteAssignment,
  releaseAssignment,
  upsertAssignment,
} from "@openbooks/engine/resourcing/assignments";
import {
  cancelResourceRequest,
  createResourceRequest,
  submitResourceRequest,
  updateResourceRequestDraft,
} from "@openbooks/engine/resourcing/requests";
import {
  closeRetainer,
  createRetainer,
  draftFeeDrawdown,
  draftHoursDrawdown,
  extendRetainer,
  updateRetainerDraft,
} from "@openbooks/engine/resourcing/retainers";
import {
  generateRetainerInvoice,
  postDrawdown,
} from "@openbooks/engine/resourcing/retainer-billing";
import {
  findUnownedCustomReferences,
  loadFieldDefs,
  unknownCustomFieldKey,
  validateCustomValues,
} from "../custom-fields";
import { validateDemandCustomValues } from "../../app/api/resourcing/demand/_custom";
import { actor, DATE, DECIMAL, IDEMPOTENCY_KEY, settleTimeRefusal, UUID } from "./time-tool-common";

const assignmentSubject = {
  employeePartyId: UUID.optional().describe("Employee party to book."),
  jobTitle: z.string().trim().min(1).max(120).optional().describe("Role for a position booking."),
};
const assignmentFields = {
  projectId: UUID.describe("Project id from the staffing board."),
  weekStart: DATE.describe("Sunday starting the assignment week."),
  plannedHours: DECIMAL.describe("Planned hours as an exact decimal string."),
  isBillable: z.boolean().optional().describe("Whether the assignment is billable."),
  billItemId: UUID.nullable().optional().describe("Billable item id, when applicable."),
  projectTaskId: UUID.nullable().optional().describe("Project task id, when applicable."),
  booking: z.enum(["soft", "hard"]).optional().describe("Soft forecast or hard commitment."),
  source: z.enum(["manual", "request", "pipeline"]).optional().describe("Origin of the booking."),
  requestId: UUID.nullable()
    .optional()
    .describe("Approved resource request id, if this fills a request."),
  custom: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Custom assignment fields from Admin → Custom Fields."),
};
const requestSubject = {
  employeePartyId: UUID.optional().describe("Employee party requested for the project."),
  jobTitle: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("Role requested when no employee is selected."),
};
const requestFields = {
  projectId: UUID.describe("Project id from the staffing board."),
  firstWeek: DATE.describe("Sunday starting the first requested week."),
  lastWeek: DATE.describe("Sunday starting the last requested week."),
  hoursPerWeek: DECIMAL.describe("Requested weekly hours as an exact decimal string."),
  isBillable: z.boolean().optional().describe("Whether the request is billable."),
  billItemId: UUID.nullable().optional().describe("Billable item id, when applicable."),
  reason: z.string().max(2000).nullable().optional().describe("Reason shown with the request."),
  custom: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Custom request fields from Admin → Custom Fields."),
};
const demandFields = {
  departmentId: UUID.describe("Department requesting capacity."),
  jobTitle: z.string().trim().min(1).max(120).describe("Role needed by the department."),
  firstWeek: DATE.describe("Sunday starting the first demand week."),
  lastWeek: DATE.describe("Sunday starting the last demand week."),
  hoursPerWeek: DECIMAL.describe("Weekly demand as an exact decimal string."),
  note: z.string().max(2000).nullable().optional().describe("Operator note for the demand line."),
  opportunityId: UUID.nullable().optional().describe("Opportunity associated with this demand."),
  custom: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Custom demand fields from Admin → Custom Fields."),
};

async function customFields(
  context: ApplicationContext,
  resource: string,
  supplied: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const defs = await loadFieldDefs(resource);
  const provided = supplied ?? {};
  const unknown = unknownCustomFieldKey(defs, provided);
  if (unknown) throw invalidInput(`unknown custom field: ${unknown}`, { field: unknown });
  const validation = validateCustomValues(defs, provided);
  if (!validation.ok)
    throw invalidInput("Custom fields are invalid.", { fields: validation.errors });
  const unowned = await findUnownedCustomReferences(context.authz.user.orgId, defs, provided);
  if (unowned.length) {
    throw invalidInput("A custom field references a record outside this organization.", {
      fields: Object.fromEntries(unowned.map((field) => [field.key, field.label])),
    });
  }
  return validation.cleaned;
}

export const RESOURCING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  timeDefinition({
    name: "assign_resourcing_capacity",
    title: "Assign Resourcing Capacity",
    description:
      "Create or update a weekly project booking for an employee or role. To fill an approved request, set source to request and pass its request id; `list_resourcing_assignments` verifies the booking.",
    inputSchema: z
      .object({ ...assignmentFields, ...assignmentSubject, idempotencyKey: IDEMPOTENCY_KEY })
      .superRefine((input, ctx) => {
        if (Boolean(input.employeePartyId) === Boolean(input.jobTitle)) {
          ctx.addIssue({
            code: "custom",
            path: ["employeePartyId"],
            message: "Choose exactly one employee or job title.",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourcing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      const custom =
        input.custom === undefined
          ? undefined
          : await customFields(context, "res_assignments", input.custom);
      try {
        const { employeePartyId, jobTitle, ...fields } = input;
        const subject = employeePartyId ? { employeePartyId } : { jobTitle: jobTitle! };
        const result = await upsertAssignment({
          ...fields,
          ...subject,
          ...(custom === undefined ? {} : { custom }),
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          assignmentId: result.assignment.id,
          status: result.assignment.state,
          assignment: result.assignment,
          href: "/resourcing/assignments",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "delete_resourcing_assignment",
    title: "Delete Resourcing Assignment",
    description:
      "Delete an editable weekly assignment by id from `list_resourcing_assignments`; posted or otherwise protected history is refused by the native resourcing service.",
    inputSchema: z.object({
      assignmentId: UUID.describe("Assignment id from list_resourcing_assignments."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourcing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        await deleteAssignment({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          assignmentId: input.assignmentId,
        });
        return {
          ok: true,
          assignmentId: input.assignmentId,
          status: "deleted",
          href: "/resourcing/assignments",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "release_resourcing_assignment",
    title: "Release Resourcing Assignment",
    description:
      "Release a weekly booking while retaining its audit history. Pass an assignment id from `list_resourcing_assignments`; the native service controls which states can be released.",
    inputSchema: z.object({
      assignmentId: UUID.describe("Assignment id from list_resourcing_assignments."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourcing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const result = await releaseAssignment({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          assignmentId: input.assignmentId,
        });
        return {
          ok: true,
          assignmentId: input.assignmentId,
          status: result.assignment.state,
          assignment: result.assignment,
          href: "/resourcing/assignments",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "create_resource_request",
    title: "Create Resource Request",
    description:
      "Create a draft staffing request for an employee or role on a project. Use `list_resource_requests` to find its id and review state before submitting it.",
    inputSchema: z
      .object({ ...requestFields, ...requestSubject, idempotencyKey: IDEMPOTENCY_KEY })
      .superRefine((input, ctx) => {
        if (Boolean(input.employeePartyId) === Boolean(input.jobTitle)) {
          ctx.addIssue({
            code: "custom",
            path: ["employeePartyId"],
            message: "Choose exactly one employee or job title.",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourceRequests",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const custom = await customFields(context, "res_requests", input.custom);
        const { employeePartyId, jobTitle, ...fields } = input;
        const subject = employeePartyId ? { employeePartyId } : { jobTitle: jobTitle! };
        const row = await createResourceRequest({
          ...fields,
          ...subject,
          custom,
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          requestId: row.id,
          status: row.status,
          request: row,
          href: "/resourcing/requests",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "update_resource_request",
    title: "Update Resource Request",
    description:
      "Replace the terms on a draft staffing request; submitted or decided requests are frozen. Find the request with `list_resource_requests`.",
    inputSchema: z
      .object({
        requestId: UUID.describe("Draft request id from list_resource_requests."),
        ...requestFields,
        ...requestSubject,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, ctx) => {
        if (Boolean(input.employeePartyId) === Boolean(input.jobTitle)) {
          ctx.addIssue({
            code: "custom",
            path: ["employeePartyId"],
            message: "Choose exactly one employee or job title.",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourceRequests",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const custom =
          input.custom === undefined
            ? undefined
            : await customFields(context, "res_requests", input.custom);
        const { employeePartyId, jobTitle, ...fields } = input;
        const subject = employeePartyId ? { employeePartyId } : { jobTitle: jobTitle! };
        const row = await updateResourceRequestDraft({
          ...fields,
          ...subject,
          ...(custom === undefined ? {} : { custom }),
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          requestId: input.requestId,
        });
        return {
          ok: true,
          requestId: row.id,
          status: row.status,
          request: row,
          href: "/resourcing/requests",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "submit_resource_request",
    title: "Submit Resource Request",
    description:
      "Submit a draft staffing request to its configured approval Flow. The request id comes from `list_resource_requests`; an approved request creates its hard weekly assignments through the native release path.",
    inputSchema: z.object({
      requestId: UUID.describe("Draft request id from list_resource_requests."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourceRequests",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const row = await submitResourceRequest({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          requestId: input.requestId,
        });
        return {
          ok: true,
          requestId: row.id,
          status: row.status,
          request: row,
          href: "/resourcing/requests",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "cancel_resource_request",
    title: "Cancel Resource Request",
    description:
      "Cancel a draft or submitted staffing request and its open approval work, with an audit reason. Find the request with `list_resource_requests`.",
    inputSchema: z.object({
      requestId: UUID.describe("Request id from list_resource_requests."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for cancellation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourceRequests",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const row = await cancelResourceRequest({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          requestId: input.requestId,
          reason: input.reason,
        });
        return {
          ok: true,
          requestId: row.id,
          status: row.status,
          request: row,
          href: "/resourcing/requests",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "create_staffing_demand",
    title: "Create Staffing Demand",
    description:
      "Create a department's weekly demand for an employee role. Use `get_staffing_demand` to inspect the range and confirm the saved line.",
    inputSchema: z.object({ ...demandFields, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourcing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const custom = await validateDemandCustomValues(context.authz.user.orgId, input.custom);
        if (custom instanceof Response) {
          const body = (await custom.json()) as Record<string, unknown>;
          throw invalidInput(String(body.error ?? "Invalid custom demand fields."), body);
        }
        const result = await createDemandLine(
          {
            ...input,
            custom: custom.cleaned,
            ...actor(context),
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
          {
            id: randomUUID(),
            requestId: context.requestId,
            match: { ...input, custom: custom.cleaned },
          },
        );
        return {
          ok: true,
          demandLineId: result.id,
          status: "active",
          demand: result,
          href: "/resourcing/demand",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "update_staffing_demand",
    title: "Update Staffing Demand",
    description:
      "Update a staffing demand line and its weekly range. Use `get_staffing_demand` to find the line; the native writer checks department scope and reports conflicts.",
    inputSchema: z.object({
      demandLineId: UUID.describe("Demand line id from get_staffing_demand."),
      ...demandFields,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourcing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        const custom = await validateDemandCustomValues(context.authz.user.orgId, input.custom);
        if (custom instanceof Response) {
          const body = (await custom.json()) as Record<string, unknown>;
          throw invalidInput(String(body.error ?? "Invalid custom demand fields."), body);
        }
        const result = await updateDemandLine({
          ...input,
          custom: custom.cleaned,
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          demandLineId: input.demandLineId,
        });
        return {
          ok: true,
          demandLineId: result.id,
          status: "active",
          demand: result,
          href: "/resourcing/demand",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "delete_staffing_demand",
    title: "Delete Staffing Demand",
    description:
      "Delete an unused staffing demand line by id from `get_staffing_demand`; protected or out-of-scope records are refused by the native writer.",
    inputSchema: z.object({
      demandLineId: UUID.describe("Demand line id from get_staffing_demand."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "resourcing.manage"),
    featureKey: "resourcing",
    execute: async (context, input) => {
      assertApplicationPermission(context, "resourcing.manage");
      try {
        await deleteDemandLine({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          demandLineId: input.demandLineId,
        });
        return {
          ok: true,
          demandLineId: input.demandLineId,
          status: "deleted",
          href: "/resourcing/demand",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "create_retainer",
    title: "Create Retainer",
    description:
      "Create draft hours or fees retainer terms for a project and its customer. Use `list_retainers` to verify the new draft before drawing down or invoicing it.",
    inputSchema: z.object({
      projectId: UUID.describe("Project id from the resourcing board."),
      customerPartyId: UUID.describe("Customer party assigned to the project."),
      kind: z.enum(["hours", "fees"]).describe("Hours or fee retainer."),
      currency: z
        .string()
        .length(3)
        .optional()
        .describe("Three-letter currency code; omit only when native configuration resolves it."),
      totalAmount: DECIMAL.optional().describe("Fee retainer amount as an exact decimal string."),
      totalHours: DECIMAL.optional().describe("Retainer hours as an exact decimal string."),
      unitRate: DECIMAL.optional().describe("Rate per hour as an exact decimal string."),
      startsOn: DATE.describe("Retainer start date."),
      endsOn: DATE.describe("Retainer end date."),
      retainerItemId: UUID.describe("Retainer item id."),
      custom: z
        .record(z.string(), z.json())
        .optional()
        .describe("Custom retainer fields from Admin → Custom Fields."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const custom = await customFields(context, "res_retainers", input.custom);
        const row = await createRetainer(
          {
            ...input,
            custom,
            ...actor(context),
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
          { id: randomUUID(), requestId: context.requestId, match: { ...input, custom } },
        );
        return {
          ok: true,
          retainerId: row.id,
          status: row.state,
          retainer: row,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "update_retainer",
    title: "Update Retainer",
    description:
      "Update draft retainer terms before it is invoiced or has drawdowns. Use `list_retainers` for the id and current state; native guards refuse changes after activation.",
    inputSchema: z.object({
      retainerId: UUID.describe("Draft retainer id from list_retainers."),
      projectId: UUID.optional().describe("Replacement project id."),
      customerPartyId: UUID.optional().describe("Replacement customer party id."),
      kind: z.enum(["hours", "fees"]).optional().describe("Retainer kind."),
      currency: z.string().length(3).optional().describe("Three-letter currency code."),
      totalAmount: DECIMAL.optional().describe("Fee retainer amount as an exact decimal string."),
      totalHours: DECIMAL.nullable()
        .optional()
        .describe("Retainer hours as an exact decimal string."),
      unitRate: DECIMAL.nullable().optional().describe("Rate per hour as an exact decimal string."),
      startsOn: DATE.optional().describe("Retainer start date."),
      endsOn: DATE.optional().describe("Retainer end date."),
      retainerItemId: UUID.optional().describe("Retainer item id."),
      custom: z
        .record(z.string(), z.json())
        .optional()
        .describe("Custom retainer fields from Admin → Custom Fields."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const custom =
          input.custom === undefined
            ? undefined
            : await customFields(context, "res_retainers", input.custom);
        const row = await updateRetainerDraft({
          ...input,
          ...(custom === undefined ? {} : { custom }),
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          retainerId: input.retainerId,
        });
        return {
          ok: true,
          retainerId: row.id,
          status: row.state,
          retainer: row,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "create_retainer_drawdown",
    title: "Create Retainer Drawdown",
    description:
      "Create a draft hours or fees drawdown for a retainer and Sunday. Use `list_retainers` to find the retainer; posted drawdowns are read from its history.",
    inputSchema: z.object({
      retainerId: UUID.describe("Retainer id from list_retainers."),
      sunday: DATE.describe("Sunday starting the drawdown week."),
      amount: DECIMAL.optional().describe("Exact fee drawdown amount; omit for an hours retainer."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const args = {
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          retainerId: input.retainerId,
        };
        const result =
          input.amount === undefined
            ? await draftHoursDrawdown({ ...args, sunday: input.sunday })
            : await draftFeeDrawdown({ ...args, sunday: input.sunday, rawAmount: input.amount });
        return {
          ok: true,
          retainerId: input.retainerId,
          drawdownId: result.drawdown.id,
          status: result.drawdown.state,
          drawdown: result,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "post_retainer_drawdown",
    title: "Post Retainer Drawdown",
    description:
      "Post a draft retainer drawdown through native revenue recognition. Pass its id from the retainer history; the service enforces balance, period and approval controls.",
    inputSchema: z.object({
      retainerId: UUID.describe("Retainer id from list_retainers."),
      drawdownId: UUID.describe("Draft drawdown id from the retainer history."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const result = await postDrawdown({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          retainerId: input.retainerId,
          drawdownId: input.drawdownId,
        });
        return {
          ok: true,
          retainerId: input.retainerId,
          drawdownId: input.drawdownId,
          status: "posted",
          ...result,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "extend_retainer",
    title: "Extend Retainer",
    description:
      "Extend a retainer to a later end date. Find the retainer with `list_retainers`; the native service checks its lifecycle and extension rules.",
    inputSchema: z.object({
      retainerId: UUID.describe("Retainer id from list_retainers."),
      newEndsOn: DATE.describe("New end date."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const result = await extendRetainer({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          retainerId: input.retainerId,
          newEndsOn: input.newEndsOn,
        });
        return {
          ok: true,
          retainerId: input.retainerId,
          status: result.state,
          retainer: result,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "close_retainer",
    title: "Close Retainer",
    description:
      "Close an exhausted retainer. Use `list_retainers` to verify its balance and state; the native writer refuses a remaining obligation.",
    inputSchema: z.object({
      retainerId: UUID.describe("Retainer id from list_retainers."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const result = await closeRetainer({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          retainerId: input.retainerId,
        });
        return {
          ok: true,
          retainerId: input.retainerId,
          status: "closed",
          ...result,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "generate_retainer_invoice",
    title: "Generate Retainer Invoice",
    description:
      "Generate a draft invoice from an active retainer's eligible drawdowns. Use `list_retainers` to find the retainer; the linked invoice is then available from the retainer or invoices list.",
    inputSchema: z.object({
      retainerId: UUID.describe("Retainer id from list_retainers."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "retainers.manage"),
    featureKey: "retainerBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "retainers.manage");
      try {
        const result = await generateRetainerInvoice({
          ...actor(context),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          retainerId: input.retainerId,
        });
        const invoiceId =
          (result as { documentId?: string; invoiceDocumentId?: string }).invoiceDocumentId ??
          (result as { documentId?: string }).documentId;
        return {
          ok: true,
          retainerId: input.retainerId,
          ...(invoiceId ? { invoiceId } : {}),
          status: "draft",
          ...result,
          href: "/resourcing/retainers",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
];
