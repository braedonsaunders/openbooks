import "server-only";
import { z } from "zod";
import {
  previewCompensationPackageVersion,
  transitionCompensationPackageAssignment,
  transitionCompensationPackageVersion,
} from "@openbooks/engine/payroll/compensation-packages";
import { assertApplicationPermission } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertPayrollFeature,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";

const REVISION = z
  .number()
  .int()
  .min(1)
  .describe("Current positive revision number returned by the setup record read.");
const REASON = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("Reason recorded with this compensation lifecycle change.");
const PREVIEW_VALUE = z
  .union([z.string().max(64), z.boolean()])
  .describe("Declared scalar or boolean input; monetary values are exact decimal strings.");
const VALUES = z
  .record(z.string().max(64).describe("Declared package input name."), PREVIEW_VALUE)
  .describe("Values for the declared package inputs.");

const versionHref = (packageId: string) =>
  `/admin/setup/payroll?tab=compensation-packages&packageId=${packageId}`;

async function authorize(
  context: Parameters<typeof assertApplicationPermission>[0],
  permission: string,
) {
  assertApplicationPermission(context, permission);
  await assertPayrollFeature(context, "compensationPackages");
}

export const PAYROLL_COMPENSATION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "preview_compensation_package_version",
    title: "Preview Compensation Package Version",
    description:
      "Evaluate a package version against a period and its declared inputs before submitting it. Find package and version ids with list_setup_records; preview returns the calculated component amounts without saving them.",
    inputSchema: z.object({
      packageId: UUID("Compensation package id from list_setup_records."),
      versionId: UUID("Compensation package version id from list_setup_records."),
      context: z
        .object({
          periodStart: DATE.describe("Start date for the preview payroll period."),
          periodEnd: DATE.describe("End date for the preview payroll period."),
          effectiveFrom: DATE.describe(
            "Start date of the employee's effective package assignment.",
          ),
          effectiveTo: DATE.nullable().describe(
            "End date of the employee's effective package assignment, or null if open.",
          ),
          values: VALUES,
          occupiedComponentIds: z
            .array(UUID("Pay component id already occupied by another source."))
            .max(64)
            .describe("Components already supplied by another payroll source."),
          replacementComponentIds: z
            .array(UUID("Pay component id intentionally replaced by this package."))
            .max(64)
            .describe("Components this package is authorized to replace."),
          suppliedComponentAmounts: z
            .record(
              UUID("Pay component id."),
              z.string().max(64).describe("Exact decimal amount as text."),
            )
            .refine((record) => Object.keys(record).length <= 64)
            .optional()
            .describe("Native component amounts to include in preview validation."),
        })
        .describe("Complete payroll context used for the read-only evaluation."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.read"),
    featureKey: "compensationPackages",
    execute: async (context, input) => {
      await authorize(context, "payroll.read");
      try {
        const preview = await previewCompensationPackageVersion({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          packageId: input.packageId,
          versionId: input.versionId,
          context: input.context,
        });
        return { ok: true, preview, href: versionHref(input.packageId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "submit_compensation_package_version",
    title: "Submit Compensation Package Version",
    description:
      "Submit a verified draft compensation package version into its configured Flow approval. Find its id and revision with list_setup_records; verify the submitted version there.",
    inputSchema: z.object({
      packageId: UUID("Compensation package id from list_setup_records."),
      versionId: UUID("Draft package version id from list_setup_records."),
      expectedRevision: REVISION,
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "compensationPackages",
    execute: async (context, input) => {
      await authorize(context, "payroll.manage");
      try {
        const version = await transitionCompensationPackageVersion({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          packageId: input.packageId,
          versionId: input.versionId,
          expectedRevision: input.expectedRevision,
          action: "submit",
          reason: input.reason,
        });
        return { ok: true, version, status: version.status, href: versionHref(input.packageId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "submit_compensation_package_assignment",
    title: "Submit Compensation Package Assignment",
    description:
      "Submit a draft employee package assignment into its configured Flow approval after verifying its package version, effective window and inputs. Find package, assignment and revision ids with list_setup_records; verify its approval status there.",
    inputSchema: z.object({
      packageId: UUID("Compensation package id from list_setup_records."),
      assignmentId: UUID("Draft package assignment id from list_setup_records."),
      expectedRevision: REVISION,
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "compensationPackages",
    execute: async (context, input) => {
      await authorize(context, "payroll.manage");
      try {
        const assignment = await transitionCompensationPackageAssignment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          packageId: input.packageId,
          assignmentId: input.assignmentId,
          expectedRevision: input.expectedRevision,
          action: "submit",
          reason: input.reason,
        });
        return {
          ok: true,
          assignment,
          status: assignment.status,
          href: versionHref(input.packageId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "cancel_compensation_package_assignment",
    title: "Cancel Compensation Package Assignment",
    description:
      "Cancel a draft compensation package assignment with a reason. Find its package, assignment and current revision using list_setup_records; verify the cancelled state there.",
    inputSchema: z.object({
      packageId: UUID("Compensation package id from list_setup_records."),
      assignmentId: UUID("Draft package assignment id from list_setup_records."),
      expectedRevision: REVISION,
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "compensationPackages",
    execute: async (context, input) => {
      await authorize(context, "payroll.manage");
      try {
        const assignment = await transitionCompensationPackageAssignment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          packageId: input.packageId,
          assignmentId: input.assignmentId,
          expectedRevision: input.expectedRevision,
          action: "cancel",
          reason: input.reason,
        });
        return {
          ok: true,
          assignment,
          status: assignment.status,
          href: versionHref(input.packageId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "end_compensation_package_assignment",
    title: "End Compensation Package Assignment",
    description:
      "End an active compensation package assignment early by shortening its effective window, with an audited reason. Find its package, assignment and current revision using list_setup_records; verify the end date there.",
    inputSchema: z.object({
      packageId: UUID("Compensation package id from list_setup_records."),
      assignmentId: UUID("Active package assignment id from list_setup_records."),
      effectiveTo: DATE.describe("Inclusive end date within the approved assignment window."),
      expectedRevision: REVISION,
      reason: REASON,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "compensationPackages",
    execute: async (context, input) => {
      await authorize(context, "payroll.manage");
      try {
        const assignment = await transitionCompensationPackageAssignment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          packageId: input.packageId,
          assignmentId: input.assignmentId,
          expectedRevision: input.expectedRevision,
          action: "end",
          effectiveTo: input.effectiveTo,
          reason: input.reason,
        });
        return {
          ok: true,
          assignment,
          status: assignment.status,
          href: versionHref(input.packageId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
];
