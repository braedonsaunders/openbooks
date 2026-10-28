import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { can, type Authz } from "../authz";
import {
  ConstructionBillingError,
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  releaseRetainage,
  submitCustomerChangeOrder,
  submitPayApplication,
  voidPayApplication,
} from "@openbooks/engine/projects/construction-billing";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { isFeatureEnabled } from "../features";
import {
  createConstructionChangeOrder,
  createConstructionSovLine,
  deleteConstructionSovLine,
  loadProjectConstructionBilling,
  updateConstructionSovLine,
  voidConstructionChangeOrder,
} from "../project-construction";
import { supportsApplicationsForPayment } from "../project-billing-procedure";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID from get_project_construction_billing or list_records.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const canArRead = (authz: Authz) => can(authz, "ar.read");

async function requireProjects(context: ApplicationContext): Promise<void> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) throw notFound("project");
}

function settleConstruction(error: unknown): never {
  if (error instanceof ConstructionBillingError) throw invalidInput(error.message);
  if (error instanceof ScopeNotFoundError) {
    throw notFound("project");
  }
  throw error;
}

async function constructionRead(context: ApplicationContext, projectId: string) {
  const data = await loadProjectConstructionBilling(
    { orgId: context.authz.user.orgId, allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds },
    projectId,
  );
  return { construction: data, href: `/projects/${projectId}?tab=construction` };
}

type WriteArgs<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permission: string;
  destructive?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
};

function constructionWrite<T extends z.ZodTypeAny>(args: WriteArgs<T>): ApplicationToolDefinition {
  const { permission, ...toolArgs } = args;
  return definition({
    ...toolArgs,
    inputSchema: toolArgs.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, permission),
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, permission);
      await requireProjects(context);
      try {
        const projectId = (input as Record<string, unknown>).projectId;
        if (
          typeof projectId === "string" &&
          !(await supportsApplicationsForPayment(context.authz.user.orgId, projectId))
        ) {
          throw invalidInput(
            "This project's billing profile does not use applications for payment",
          );
        }
        return await args.execute(context, input);
      } catch (error) {
        settleConstruction(error);
      }
    },
  });
}

export const PROJECT_CONSTRUCTION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_project_construction_billing",
    title: "Get Project Construction Billing",
    description:
      "Read the schedule of values, change orders, pay applications, retainage held, and committed cost for a project. Find its id with list_records.",
    inputSchema: z.object({ projectId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canArRead,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.read");
      await requireProjects(context);
      try {
        return { ok: true, ...(await constructionRead(context, input.projectId)) };
      } catch (error) {
        settleConstruction(error);
      }
    },
  }),
  constructionWrite({
    name: "add_project_schedule_value",
    title: "Add Project Schedule Value",
    description:
      "Add a Schedule of Values line before billing begins. Find the project with list_records and verify the line with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      description: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Contract work description for this schedule line."),
      scheduledValue: z
        .string()
        .max(40)
        .describe("Positive scheduled contract value as exact decimal text."),
      retainagePercent: z
        .string()
        .nullable()
        .optional()
        .describe("Optional retainage percentage as exact decimal text."),
      itemNo: z
        .string()
        .max(80)
        .nullable()
        .optional()
        .describe("Optional customer schedule-of-values item number."),
      sortOrder: z.number().int().optional().describe("Display order for this schedule line."),
      incomeAccountId: UUID.nullable()
        .optional()
        .describe("Optional project income account override."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      const id = await createConstructionSovLine(
        {
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        input,
      );
      return { ok: true, id, ...(await constructionRead(context, input.projectId)) };
    },
  }),
  constructionWrite({
    name: "update_project_schedule_value",
    title: "Update Project Schedule Value",
    description:
      "Edit an unused Schedule of Values line, or change only its income account after billing controls it. Find line ids with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      lineId: UUID,
      description: z.string().trim().min(1).max(2000).describe("Schedule line description."),
      scheduledValue: z
        .string()
        .max(40)
        .describe("Scheduled contract value as exact decimal text."),
      retainagePercent: z
        .string()
        .max(40)
        .nullable()
        .optional()
        .describe("Retainage percentage as exact decimal text, or null."),
      itemNo: z
        .string()
        .max(80)
        .nullable()
        .optional()
        .describe("Customer schedule-of-values item number."),
      incomeAccountId: UUID.nullable()
        .optional()
        .describe("Income account override for this line."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      await updateConstructionSovLine(
        {
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        {
          projectId: input.projectId,
          id: input.lineId,
          description: input.description,
          scheduledValue: input.scheduledValue,
          retainagePercent: input.retainagePercent,
          itemNo: input.itemNo,
          incomeAccountId: input.incomeAccountId,
        },
      );
      return {
        ok: true,
        lineId: input.lineId,
        ...(await constructionRead(context, input.projectId)),
      };
    },
  }),
  constructionWrite({
    name: "delete_project_schedule_value",
    title: "Delete Project Schedule Value",
    description:
      "Delete an unused Schedule of Values line. Controlled or billed lines must be reduced through a change order; find the id with get_project_construction_billing.",
    inputSchema: z.object({ projectId: UUID, lineId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    permission: "ar.create",
    destructive: true,
    execute: async (context, input) => {
      await deleteConstructionSovLine(
        {
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        input.projectId,
        input.lineId,
      );
      return {
        ok: true,
        lineId: input.lineId,
        ...(await constructionRead(context, input.projectId)),
      };
    },
  }),
  constructionWrite({
    name: "create_project_change_order",
    title: "Create Project Change Order",
    description:
      "Create a draft additive or deductive change order; a deductive order must target a Schedule of Values line. Find project and target line ids with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      number: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("Unique change-order number within the project."),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional change description."),
      amount: z.string().max(40).describe("Exact decimal signed change amount."),
      targetSovLineId: UUID.nullable()
        .optional()
        .describe("Schedule line affected by this change order."),
      incomeAccountId: UUID.nullable()
        .optional()
        .describe("Optional income account for the resulting schedule line."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      const id = await createConstructionChangeOrder(
        {
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        input,
      );
      return { ok: true, id, ...(await constructionRead(context, input.projectId)) };
    },
  }),
  constructionWrite({
    name: "approve_project_change_order",
    title: "Approve Project Change Order",
    description:
      "Approve a draft change order on the stated date; approval updates the controlled contract schedule under the native project billing rules. Find it with get_project_construction_billing.",
    inputSchema: z.object({
      changeOrderId: UUID,
      approvedOn: DATE.nullable()
        .optional()
        .describe("Approval date; omitted uses the organization's business date."),
      projectId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      const result = await submitCustomerChangeOrder({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        id: input.changeOrderId,
        approvedOn: input.approvedOn ?? (await businessToday(context.authz.user.orgId)),
      });
      return { ok: true, ...result, ...(await constructionRead(context, input.projectId)) };
    },
  }),
  constructionWrite({
    name: "void_project_change_order",
    title: "Void Project Change Order",
    description:
      "Void an unapproved draft change order. Find its id with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      changeOrderId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    destructive: true,
    execute: async (context, input) => {
      await voidConstructionChangeOrder(
        {
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        },
        input.projectId,
        input.changeOrderId,
      );
      return {
        ok: true,
        changeOrderId: input.changeOrderId,
        ...(await constructionRead(context, input.projectId)),
      };
    },
  }),
  constructionWrite({
    name: "create_project_pay_application",
    title: "Create Project Pay Application",
    description:
      "Start the next draft progress application after the prior draw is completed or voided. Find project and schedule ids with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      periodEnd: DATE,
      retainagePercent: z.string().max(40).describe("Retainage percentage as exact decimal text."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      if (!(await supportsApplicationsForPayment(context.authz.user.orgId, input.projectId)))
        throw invalidInput("This project's billing profile does not use applications for payment");
      const result = await createPayApplication(
        context.authz.user.orgId,
        context.authz.user.id,
        input.projectId,
        input.periodEnd,
        input.retainagePercent,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...result, ...(await constructionRead(context, input.projectId)) };
    },
  }),
  constructionWrite({
    name: "submit_project_pay_application",
    title: "Submit Project Pay Application",
    description:
      "Save current-period completion and stored-material amounts to a draft pay application and submit it through native approval routing. Find its line ids with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      payApplicationId: UUID,
      lines: z
        .array(
          z.object({
            sovLineId: UUID,
            thisPeriodCompleted: z
              .string()
              .max(40)
              .describe("Exact decimal gross work completed this period; empty means zero."),
            materialsStored: z
              .string()
              .max(40)
              .describe("Exact decimal materials stored this period; empty means zero."),
          }),
        )
        .max(1000)
        .optional()
        .describe("Draw values for schedule lines; omitted lines remain zero."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      const lines = (input.lines ?? []).map((line) => ({
        sovLineId: line.sovLineId,
        thisPeriodCompleted: line.thisPeriodCompleted,
        materialsStored: line.materialsStored,
      }));
      const application = await submitPayApplication(
        context.authz.user.orgId,
        context.authz.user.id,
        input.payApplicationId,
        lines,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, application, ...(await constructionRead(context, input.projectId)) };
    },
  }),
  constructionWrite({
    name: "approve_project_pay_application",
    title: "Approve Project Pay Application",
    description:
      "Approve a submitted pay application through its native Flow gates. Find it with get_project_construction_billing; use decide_approval when the application is waiting on a configured Flow.",
    inputSchema: z.object({
      projectId: UUID,
      payApplicationId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.create",
    execute: async (context, input) => {
      await approvePayApplication(
        context.authz.user.orgId,
        context.authz.user.id,
        input.payApplicationId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        payApplicationId: input.payApplicationId,
        ...(await constructionRead(context, input.projectId)),
      };
    },
  }),
  constructionWrite({
    name: "void_project_pay_application",
    title: "Void Project Pay Application",
    description:
      "Void a pay application that has not been invoiced, subject to later-draw controls. Find it with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      payApplicationId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.approve",
    destructive: true,
    execute: async (context, input) => {
      await voidPayApplication(
        context.authz.user.orgId,
        context.authz.user.id,
        input.payApplicationId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        payApplicationId: input.payApplicationId,
        ...(await constructionRead(context, input.projectId)),
      };
    },
  }),
  constructionWrite({
    name: "bill_project_pay_application",
    title: "Bill Project Pay Application",
    description:
      "Generate a draft customer invoice from an approved pay application, including earned retainage. Find it with get_project_construction_billing and verify the invoice with get_record.",
    inputSchema: z.object({
      projectId: UUID,
      payApplicationId: UUID,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.post",
    execute: async (context, input) => {
      const result = await generatePayApplicationInvoice(
        context.authz.user.orgId,
        context.authz.user.id,
        input.payApplicationId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        invoiceId: result.invoiceId,
        documentNumber: result.documentNumber,
        currentDue: result.currentDue,
        retainage: result.retainage,
        status: "draft",
        href: `/invoices/${result.invoiceId}`,
      };
    },
  }),
  constructionWrite({
    name: "release_project_retainage",
    title: "Release Project Retainage",
    description:
      "Create a draft retainage-release invoice for available held amounts on a project and through date. Find the project and held balance with get_project_construction_billing.",
    inputSchema: z.object({
      projectId: UUID,
      periodEnd: DATE,
      amount: z.string().max(40).describe("Positive exact decimal amount to release."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    permission: "ar.post",
    execute: async (context, input) => {
      const result = await releaseRetainage(
        context.authz.user.orgId,
        context.authz.user.id,
        input.projectId,
        input.periodEnd,
        input.amount,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...result, status: "draft", href: `/invoices/${result.invoiceId}` };
    },
  }),
];
