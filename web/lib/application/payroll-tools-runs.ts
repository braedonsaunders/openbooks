import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { can } from "../authz";
import {
  createPayRun,
  discardPayRun,
  attributePayRunEntity,
} from "@openbooks/engine/payroll/run-lifecycle";
import { calculatePayRun } from "@openbooks/engine/payroll/run-calculation";
import {
  commitPayRun,
  previewPayRunGl,
  acknowledgePayRunRefusals,
} from "@openbooks/engine/payroll/run-commit";
import { assertPayRunNotStale } from "@openbooks/engine/payroll/readiness";
import {
  assertPayRunApprovalReleased,
  recalculateStaleApprovedPayRun,
} from "@openbooks/engine/payroll/approval";
import { recordPayRunPayment } from "@openbooks/engine/payroll/payment";
import { generatePayRunBankFile } from "@openbooks/engine/payroll/bank-file-artifact";
import { rebuildPayRunGlProjection } from "@openbooks/engine/payroll/run-gl-rebuild";
import {
  mutatePayRunAdjustment,
  recordPayRunHolidayHours,
  payRunBulkAdjustmentId,
  PayRunAdjustmentIdempotencyConflict,
} from "@openbooks/engine/payroll/run-adjustments";
type EmployerLevyAdjustmentMutation = Extract<
  Parameters<typeof mutatePayRunAdjustment>[0]["mutation"],
  { action: "employer_levy_adjustment" }
>;
import { resolvePayrollProfileEmploymentLinks } from "@openbooks/engine/payroll/profile-employment";
import {
  payRunApprovalState,
  recalculateStaleApprovedPayRun,
} from "@openbooks/engine/payroll/approval";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { emailRunStubs } from "../payroll-outputs";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { submitPayRunForApproval } from "../payroll/run-approval";
import {
  assertPayRunAccess,
  assertPayrollActor,
  assertPayrollEmployeeAccess,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { conflict } from "./errors";

const PAY_RUN_HREF = (documentId: string) => `/payroll/runs/${documentId}`;
const runType = z
  .enum(["regular", "bonus", "termination", "supplemental"])
  .default("regular")
  .describe("Regular follows the schedule; the other types create off-cycle pay runs.");
const hours = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,2})?$/)
  .describe("Exact hours as text with at most two fractional places.");

function settleRunAdjustmentRefusal(error: unknown): never {
  if (error instanceof PayRunAdjustmentIdempotencyConflict) throw conflict(error.message);
  settlePayrollRefusal(error);
}

export const PAYROLL_RUN_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_pay_run",
    title: "Create Pay Run",
    description:
      "Create a regular or off-cycle pay run from an active pay schedule. Copy the schedule and employee ids from payroll setup and employee reads; inspect the created run with get_pay_run.",
    inputSchema: z
      .object({
        payScheduleId: UUID("Active pay schedule id from setup records."),
        periodStart: DATE.optional().describe(
          "First date of the pay period; omit both period dates to use the next scheduled period.",
        ),
        periodEnd: DATE.optional().describe(
          "Last date of the pay period; provide together with periodStart.",
        ),
        payDate: DATE.optional().describe("Settlement date; defaults from the schedule."),
        runType,
        employeePartyIds: z
          .array(UUID("Employee party id from list_payroll_employees."))
          .max(2000)
          .optional()
          .describe("Employees paid by a termination run; required for termination runs."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) => input.runType !== "termination" || (input.employeePartyIds?.length ?? 0) > 0,
        {
          message: "A termination run must name the employees it pays.",
          path: ["employeePartyIds"],
        },
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      try {
        const result = await createPayRun({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          payScheduleId: input.payScheduleId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          payDate: input.payDate,
          runType: input.runType,
          employeePartyIds: input.employeePartyIds,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, status: "draft", href: PAY_RUN_HREF(result.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "preview_pay_run_calculation",
    title: "Preview Pay Run Calculation",
    description:
      "Recalculate a pay run in a rolled-back preview to see payroll blockers and results without saving stubs. Find the run id with list_pay_runs and read the result with get_pay_run.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs or get_pay_run."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await calculatePayRun({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          dryRun: true,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "calculate_pay_run",
    title: "Calculate Pay Run",
    description:
      "Calculate and save payroll figures for an editable pay run after resolving readiness blockers. Find the run with list_pay_runs, then verify figures and exceptions with get_pay_run.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs or get_pay_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    transactionIsolationLevel: "REPEATABLE READ",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await calculatePayRun({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "submit_pay_run_for_approval",
    title: "Submit Pay Run for Approval",
    description:
      "Submit a fresh calculated pay run with its payroll evidence to the configured approval flow. Use get_pay_run and the approval worklist to verify the run and its pending gates.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs or get_pay_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await submitPayRunForApproval({
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          documentId: input.documentId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        if (!result.ok) throw new PayrollError(result.error);
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "commit_pay_run",
    title: "Commit Pay Run",
    description:
      "Commit a calculated and released pay run to its payroll ledger projection after all blocking exceptions are resolved or acknowledged. Find the run with list_pay_runs and verify the committed state with get_pay_run.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs or get_pay_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        await assertPayRunNotStale(
          context.authz.user.orgId,
          input.documentId,
          db,
          context.authz.allowedSubsidiaryIds,
        );
        await assertPayRunApprovalReleased(context.authz.user.orgId, input.documentId);
        const result = await commitPayRun({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, status: "committed", href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "record_pay_run_payment",
    title: "Record Pay Run Payment",
    description:
      "Record settlement for a posted pay run using one bank account or its designated clearing account. Find the run with list_pay_runs and verify the payment evidence from the payroll run detail.",
    inputSchema: z
      .object({
        documentId: UUID("Posted pay run document id from list_pay_runs."),
        bankAccountId: UUID("Bank account used to settle net pay.").optional(),
        settlementClearingAccountId: UUID(
          "Designated net-pay settlement clearing account.",
        ).optional(),
        paidOn: DATE.optional().describe("Payment settlement date; defaults to the pay date."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          (input.bankAccountId === undefined) !== (input.settlementClearingAccountId === undefined),
        "Choose exactly one settlement account.",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await recordPayRunPayment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          documentId: input.documentId,
          bankAccountId: input.bankAccountId,
          settlementClearingAccountId: input.settlementClearingAccountId,
          paidOn: input.paidOn,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, status: "paid", href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "discard_pay_run",
    title: "Discard Pay Run",
    description:
      "Discard an uncommitted draft pay run with a recorded reason. Find the draft with list_pay_runs and verify its final state with get_pay_run.",
    inputSchema: z.object({
      documentId: UUID("Draft pay run document id from list_pay_runs."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for discarding the draft.")
        .optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await discardPayRun({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, status: "discarded", href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "acknowledge_pay_run_refusals",
    title: "Acknowledge Pay Run Refusals",
    description:
      "Record the explicit decision to commit while the run contains refused employees, using the current server-side refusal set. Find the run with list_pay_runs and review its readiness with get_pay_run first.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const acknowledgement = await acknowledgePayRunRefusals({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, acknowledgement, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "attribute_pay_run_entity",
    title: "Attribute Pay Run Entity",
    description:
      "Attribute a legacy committed pay run without a legal entity to its correct subsidiary, provided its posted accounting history allows it. Find the run with list_pay_runs and subsidiaries through setup reads.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs."),
      subsidiaryId: UUID("Target active subsidiary id from setup records."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await attributePayRunEntity({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          subsidiaryId: input.subsidiaryId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "generate_pay_run_bank_file",
    title: "Generate Pay Run Bank File",
    description:
      "Generate an immutable direct-deposit artifact for a committed and released pay run using an enabled payment bank profile. Find the run with list_pay_runs and choose a profile from the bank-file panel's payroll read.",
    inputSchema: z.object({
      documentId: UUID("Committed pay run document id from list_pay_runs."),
      paymentBankProfileId: UUID("Enabled payroll payment bank profile id."),
      supersedeReason: z
        .string()
        .trim()
        .max(500)
        .nullable()
        .optional()
        .describe("Reason for replacing a prior generated artifact."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const artifact = await generatePayRunBankFile({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          paymentBankProfileId: input.paymentBankProfileId,
          supersedeReason: input.supersedeReason?.trim() || null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, artifact, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error, 409);
      }
    },
  }),
  definition({
    name: "rebuild_pay_run_gl_projection",
    title: "Rebuild Pay Run GL Projection",
    description:
      "Rebuild a committed, never-posted run's GL projection after an audited correction reason and reviewed revision. Read the current projection from the run's GL projection panel before supplying its revision and hash.",
    inputSchema: z.object({
      documentId: UUID("Committed pay run document id from list_pay_runs."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Business reason for this governed rebuild."),
      expectedRevision: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .describe("Projection revision returned by the native GL projection read."),
      entitlementRelief: z
        .object({
          expectedProjectionHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .describe("Projection hash returned by the native GL projection read."),
          bindings: z
            .array(
              z.object({
                planId: UUID("Entitlement plan id."),
                liabilityAccountId: UUID("Liability account id."),
              }),
            )
            .min(1)
            .max(50)
            .describe("Plan-to-liability account bindings reviewed for this correction."),
        })
        .optional()
        .describe("Reviewed entitlement-liability coding correction."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await rebuildPayRunGlProjection({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          expectedRevision: input.expectedRevision,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          entitlementRelief: input.entitlementRelief,
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error, 409);
      }
    },
  }),
  definition({
    name: "preview_pay_run_gl",
    title: "Preview Pay Run GL",
    description:
      "Preview the exact ledger legs a calculated pay run will commit, including accounts, parties and projects. Find the run with list_pay_runs and review its payroll state with get_pay_run.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs or get_pay_run."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        return {
          ok: true,
          ...(await previewPayRunGl(
            context.authz.user.orgId,
            input.documentId,
            context.authz.allowedSubsidiaryIds,
          )),
          href: PAY_RUN_HREF(input.documentId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "get_pay_run_approval_state",
    title: "Get Pay Run Approval State",
    description:
      "Read whether a pay run is submitted, pending or released for commit. Find the run with list_pay_runs; decide any waiting gates with decide_approval and verify the state here.",
    inputSchema: z.object({ documentId: UUID("Pay run document id from list_pay_runs.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        return {
          ok: true,
          ...(await payRunApprovalState(context.authz.user.orgId, input.documentId)),
          href: PAY_RUN_HREF(input.documentId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "add_pay_run_adjustment",
    title: "Add Pay Run Adjustment",
    description:
      "Add one exact earning or deduction adjustment for a roster employee before recalculating the run. Find the employee and adjustable component ids in get_pay_run; verify the saved adjustment in the run detail.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs."),
      employeePartyId: UUID("Employee party id on this run's roster."),
      componentId: UUID("Adjustable pay component id from get_pay_run."),
      amount: z
        .string()
        .regex(/^-?\d+(?:\.\d{1,4})?$/)
        .describe("Exact signed amount as text, at most four fractional places."),
      hours: hours.nullable().optional().describe("Hours for an hourly line, when applicable."),
      earnedFrom: DATE.nullable()
        .optional()
        .describe("First date the adjustment was earned, when a dated source window applies."),
      earnedTo: DATE.nullable()
        .optional()
        .describe("Last date the adjustment was earned, when a dated source window applies."),
      replaceComponent: z
        .boolean()
        .optional()
        .describe("Replace this component's calculated amount for the employee."),
      note: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Supporting note stored with the adjustment."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason recorded in the payroll input audit."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: {
            action: "add",
            employeePartyId: input.employeePartyId,
            componentId: input.componentId,
            amount: input.amount,
            hours: input.hours,
            earnedFrom: input.earnedFrom,
            earnedTo: input.earnedTo,
            replaceComponent: input.replaceComponent,
            note: input.note,
            idempotencyKey: randomUUID(),
          },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "bulk_adjust_pay_run",
    title: "Bulk Adjust Pay Run",
    description:
      "Apply the same exact component amount to selected run employees in one all-or-nothing transaction, then recalculate the run. Copy employee and adjustable component ids from get_pay_run and review the persisted adjustments there.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id from list_pay_runs."),
      componentId: UUID("Adjustable pay component id from get_pay_run."),
      amount: z
        .string()
        .regex(/^-?\d+(?:\.\d{1,4})?$/)
        .describe("Exact signed amount applied to each selected employee."),
      employeePartyIds: z
        .array(UUID("Employee party id on this run's roster."))
        .min(1)
        .max(2000)
        .describe("Employees receiving the same adjustment."),
      note: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Supporting note stored with each adjustment."),
      replaceComponent: z
        .boolean()
        .optional()
        .describe("Replace each employee's calculated component amount."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        await withOrgTransaction(context.authz.user.orgId, async () => {
          for (const employeePartyId of input.employeePartyIds)
            await mutatePayRunAdjustment({
              orgId: context.authz.user.orgId,
              documentId: input.documentId,
              actorId: context.authz.user.id,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
              mutation: {
                action: "add",
                employeePartyId,
                componentId: input.componentId,
                amount: input.amount,
                note: input.note,
                replaceComponent: input.replaceComponent,
                idempotencyKey: payRunBulkAdjustmentId(input.idempotencyKey, employeePartyId),
              },
            });
        });
        return {
          ok: true,
          applied: input.employeePartyIds.length,
          href: PAY_RUN_HREF(input.documentId),
        };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_pay_run_adjustment",
    title: "Delete Pay Run Adjustment",
    description:
      "Remove an editable adjustment from a draft pay run; deleting it invalidates the prior calculation. Find the adjustment id in get_pay_run and verify its removal in the same run detail.",
    inputSchema: z.object({
      documentId: UUID("Draft pay run document id."),
      adjustmentId: UUID("Adjustment id from get_pay_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: { action: "delete", adjustmentId: input.adjustmentId },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "set_pay_run_employee_inclusion",
    title: "Set Pay Run Employee Inclusion",
    description:
      "Include or exclude one schedule employee from a draft pay run, then recalculate the run. Find the roster employee id with get_pay_run and verify the updated run scope there.",
    inputSchema: z.object({
      documentId: UUID("Draft pay run document id."),
      employeePartyId: UUID("Employee party id on the run's schedule."),
      action: z
        .enum(["include", "exclude"])
        .describe("Whether this employee is included in the pay run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: { action: input.action, employeePartyId: input.employeePartyId },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "set_pay_run_employee_scope",
    title: "Set Pay Run Employee Scope",
    description:
      "Set the complete included roster for a draft pay run; the command applies only membership changes in one transaction. Copy the current roster from get_pay_run, choose the employees who remain included, then recalculate and verify the run.",
    inputSchema: z
      .object({
        documentId: UUID("Draft pay run document id."),
        employeePartyIds: z
          .array(UUID("Employee party id to keep included."))
          .max(2000)
          .describe("Employees to include from the supplied run roster."),
        rosterPartyIds: z
          .array(UUID("Employee party id currently on the run roster."))
          .max(2000)
          .describe("Complete run roster copied from get_pay_run."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => input.employeePartyIds.every((id) => input.rosterPartyIds.includes(id)), {
        message: "Every included employee must be on the supplied run roster.",
        path: ["employeePartyIds"],
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        let included = 0;
        let excluded = 0;
        await withOrgTransaction(context.authz.user.orgId, async () => {
          const rows = await db.execute<{ employee_party_id: string }>(
            sql`select employee_party_id from pay_run_adjustments where org_id=${context.authz.user.orgId} and pay_run_document_id=${input.documentId} and adjustment_type='exclude'`,
            "objects",
          );
          const currentExcluded = new Set(rows.map((row) => row.employee_party_id));
          const keep = new Set(input.employeePartyIds);
          for (const employeePartyId of input.rosterPartyIds) {
            const wanted = keep.has(employeePartyId) ? "include" : "exclude";
            const current = currentExcluded.has(employeePartyId) ? "exclude" : "include";
            if (wanted === current) continue;
            const result = await mutatePayRunAdjustment({
              orgId: context.authz.user.orgId,
              documentId: input.documentId,
              actorId: context.authz.user.id,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
              mutation: { action: wanted, employeePartyId },
            });
            if (result.changed) {
              if (wanted === "include") included += 1;
              else excluded += 1;
            }
          }
        });
        return { ok: true, included, excluded, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "record_pay_run_holiday_hours",
    title: "Record Pay Run Holiday Hours",
    description:
      "Record audited paid holiday hours for one run employee before recalculation. Find the employee and holiday dates with get_pay_run and the holiday obligation read; verify the resulting adjustment in the run detail.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id."),
      employeePartyId: UUID("Employee party id on the run's roster."),
      hours: z
        .string()
        .regex(/^\d+(?:\.\d{1,2})?$/)
        .describe("Non-negative paid hours as exact text, at most two fractional places."),
      earnedOn: DATE.optional().describe("Date these paid holiday hours were earned."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason recorded in the payroll input audit."),
      note: z.string().max(500).optional().describe("Additional supporting note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await recordPayRunHolidayHours({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          employeePartyId: input.employeePartyId,
          hours: input.hours,
          earnedOn: input.earnedOn,
          reason: input.reason,
          note: input.note,
          idempotencyKey: randomUUID(),
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "override_pay_run_income_tax",
    title: "Override Pay Run Income Tax",
    description:
      "Record an evidenced absolute income-tax withholding override for one employee's cheque; the pack calculation remains authoritative for all other withholding. Find the employee on get_pay_run and retain the source document reference and reason.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id."),
      employeePartyId: UUID("Employee party id on the run roster."),
      amount: z
        .string()
        .regex(/^\d+(?:\.\d{1,2})?$/)
        .describe(
          "Non-negative absolute withholding amount as exact text, at most two fractional places.",
        ),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason for the evidenced withholding override."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe("Reference to the issued instruction or source record."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: {
            action: "override_income_tax",
            employeePartyId: input.employeePartyId,
            amount: input.amount,
            reason: input.reason,
            sourceReference: input.sourceReference,
            idempotencyKey: randomUUID(),
          },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "record_pay_run_bank_cash_input",
    title: "Record Pay Run Bank Cash Input",
    description:
      "Record an evidenced withdrawal or deposit against an employee's configured payroll entitlement bank. Find the employee, payout/deposit component and issued evidence with get_pay_run; verify the adjustment in the run detail.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id."),
      employeePartyId: UUID("Employee party id on the run roster."),
      componentId: UUID("Configured bank payout or deposit component id from get_pay_run."),
      hours: z
        .string()
        .regex(/^-?\d+(?:\.\d{1,2})?$/)
        .describe("Signed entitlement hours as exact text; negative values represent deposits."),
      amount: z
        .string()
        .regex(/^-?\d+(?:\.\d{1,4})?$/)
        .nullable()
        .optional()
        .describe("Issued cash amount, if supplied."),
      rate: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .nullable()
        .optional()
        .describe("Keyed hourly rate, if supplied."),
      outsideBankAmount: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .nullable()
        .optional()
        .describe("Positive amount already paid outside the entitlement bank, when applicable."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason for the issued bank cash evidence."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe("Reference to the issued source record."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: {
            action: "bank_cash_input",
            employeePartyId: input.employeePartyId,
            componentId: input.componentId,
            hours: input.hours,
            amount: input.amount,
            rate: input.rate,
            outsideBankAmount: input.outsideBankAmount,
            reason: input.reason,
            sourceReference: input.sourceReference,
            idempotencyKey: randomUUID(),
          },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "record_pay_run_vacation_accrual",
    title: "Record Pay Run Vacation Accrual",
    description:
      "Record an issued vacation liability amount for one employee's pay run where the configured payroll pack requires declared accrual evidence. Find the employee and issued source with get_pay_run; verify the recorded adjustment in the run detail.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id."),
      employeePartyId: UUID("Employee party id on the run roster."),
      amount: z
        .string()
        .regex(/^\d+(?:\.\d{1,2})?$/)
        .describe("Positive issued accrual as exact decimal text, at most two fractional places."),
      reason: z.string().trim().min(1).max(500).describe("Reason for the issued accrual."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe("Reference to the issued source record."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: {
            action: "declared_vacation_accrual",
            employeePartyId: input.employeePartyId,
            amount: input.amount,
            reason: input.reason,
            sourceReference: input.sourceReference,
            idempotencyKey: randomUUID(),
          },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "record_pay_run_employer_levy",
    title: "Record Pay Run Employer Levy",
    description:
      "Record a source-backed issued employer levy amount against one employee's run. Copy the pack program, worker compensation group and source key from the employer levy opening/issued evidence; verify the adjustment in get_pay_run.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id."),
      employeePartyId: UUID("Employee party id on the run roster."),
      programKey: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,63}$/)
        .describe("Employer levy program key supplied by the configured payroll pack."),
      workerCompGroupId: UUID("Dated worker compensation group id, when the pack requires one.")
        .nullable()
        .optional(),
      amount: z
        .string()
        .regex(/^\d+(?:\.\d{1,2})?$/)
        .describe("Issued premium amount as exact decimal text, at most two fractional places."),
      sourceKey: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Stable identity of the issued source record."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason for recording this issued amount."),
      sourceReference: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe("Reference to the issued source document."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await mutatePayRunAdjustment({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          mutation: {
            action: "employer_levy_adjustment",
            employeePartyId: input.employeePartyId,
            programKey: input.programKey as EmployerLevyAdjustmentMutation["programKey"],
            workerCompGroupId: input.workerCompGroupId,
            amount: input.amount,
            sourceKey: input.sourceKey,
            reason: input.reason,
            sourceReference: input.sourceReference,
            idempotencyKey: randomUUID(),
          },
        });
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settleRunAdjustmentRefusal(error);
      }
    },
  }),
  definition({
    name: "recalculate_approved_pay_run",
    title: "Recalculate Approved Pay Run",
    description:
      "Return a stale approved pay run to draft, recalculate its changed inputs and resubmit it through the same configured approval flow. Use get_pay_run to confirm the stale state and review new approval gates with list_approvals.",
    inputSchema: z.object({
      documentId: UUID("Approved pay run document id from list_pay_runs."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "payroll.run") && can(authz, "payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayrollActor(context, "payroll.manage");
      await assertPayRunAccess(context, input.documentId);
      try {
        const recalculated = await recalculateStaleApprovedPayRun({
          orgId: context.authz.user.orgId,
          documentId: input.documentId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        const base = { ...recalculated.calculation, reasons: recalculated.reasons };
        const approval = await payRunApprovalState(context.authz.user.orgId, input.documentId);
        if (!approval.policyExists)
          return {
            ok: true,
            ...base,
            resubmitted: false,
            gated: false,
            href: PAY_RUN_HREF(input.documentId),
          };
        const resubmitted = await submitPayRunForApproval({
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          documentId: input.documentId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        }).catch((error: unknown) => {
          if (error instanceof PayrollError) return { ok: false as const, error: error.message };
          throw error;
        });
        if (!resubmitted.ok)
          throw new PayrollError(
            `The run was recalculated and returned to draft, but it was not sent for approval: ${resubmitted.error}`,
          );
        return {
          ok: true,
          ...base,
          resubmitted: true,
          gated: resubmitted.gated,
          href: PAY_RUN_HREF(input.documentId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "resolve_pay_run_employment_links",
    title: "Resolve Pay Run Employment Links",
    description:
      "Fill missing employee payroll-profile employment links only where one eligible employment is unambiguous. Find affected employees with list_payroll_employees and verify the resolved links with the payroll employee read.",
    inputSchema: z.object({
      documentId: UUID("Pay run document id whose readiness report shows missing links."),
      employeePartyIds: z
        .array(UUID("Employee party id from list_payroll_employees."))
        .max(2000)
        .optional()
        .describe(
          "Limit repair to these employees; omit to resolve all visible unlinked profiles.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayrollActor(context, "payroll.manage");
      await assertPayRunAccess(context, input.documentId);
      if (input.employeePartyIds?.length)
        await assertPayrollEmployeeAccess(context, input.employeePartyIds);
      try {
        const links = await resolvePayrollProfileEmploymentLinks({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          employeePartyIds: input.employeePartyIds?.length ? input.employeePartyIds : undefined,
          reason: "Pay-run readiness Resolve action",
          dryRun: false,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          linked: links.linked,
          unresolved: links.unresolved,
          href: PAY_RUN_HREF(input.documentId),
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "email_pay_run_stubs",
    title: "Email Pay Run Stubs",
    description:
      "Email encrypted pay stubs to employees whose payroll delivery preference allows email; refuses delivery without the configured password policy. Find the run with list_pay_runs and review sent, print-only and failed counts in the result.",
    inputSchema: z.object({
      documentId: UUID("Committed pay run document id from list_pay_runs."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      await assertPayRunAccess(context, input.documentId);
      try {
        const result = await emailRunStubs(
          context.authz.user.orgId,
          input.documentId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: PAY_RUN_HREF(input.documentId) };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
];
