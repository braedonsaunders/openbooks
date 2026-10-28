import "server-only";
import { z } from "zod";
import {
  deleteUnusedEmployeePayComponentAssignment,
  endEmployeePayComponentAssignment,
  listEmployeePayComponentAssignments,
  saveEmployeePayComponentAssignment,
  type AssignmentRunApplicability,
} from "@openbooks/engine/payroll/assigned-components";
import { createRemittanceBill } from "@openbooks/engine/payroll/remittance";
import { createRetroPayRun, proposeRetroPay } from "@openbooks/engine/payroll/retro-store";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertPayrollActor,
  assertPayrollEmployeeAccess,
  DATE,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";
import { invalidInput, notFound } from "./errors";
import {
  assertRetroExcludedSourcesInScope,
  RetroScopeNotFound,
  scopedRetroEmployees,
} from "../payroll/retro-scope";

const APPLICATIONS = [
  "standard_runs",
  "regular_only",
  "periodic_and_final",
] as const satisfies readonly AssignmentRunApplicability[];
const exactDecimal = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal text with at most four fractional places.");

async function employeeAssignmentRead(
  orgId: string,
  employeePartyId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return listEmployeePayComponentAssignments({ orgId, employeePartyId, allowedSubsidiaryIds });
}

export const PAYROLL_OPERATION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_employee_pay_components",
    title: "List Employee Pay Components",
    description:
      "Read one employee's effective-dated recurring pay-component assignments, available user-defined components and employments. Find the employee id with list_payroll_employees; use the returned assignment and component ids for employee pay setup commands.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from list_payroll_employees."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const result = await employeeAssignmentRead(
          context.authz.user.orgId,
          input.employeePartyId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: `/payroll?employee=${input.employeePartyId}` };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("record");
        throw error;
      }
    },
  }),
  definition({
    name: "assign_employee_pay_component",
    title: "Assign Employee Pay Component",
    description:
      "Add an effective-dated recurring payroll component for an employee, including fixed deductions and taxable benefits. Choose employee and component ids from list_payroll_employees and payroll setup reads; verify the assignment in the employee's payroll component list.",
    inputSchema: z.object({
      employeePartyId: UUID("Employee party id from list_payroll_employees."),
      employmentId: UUID(
        "Employment id belonging to this employee, or omit for a party-wide assignment.",
      )
        .nullable()
        .optional(),
      componentId: UUID("User-defined pay component id from payroll setup."),
      value: exactDecimal
        .nullable()
        .optional()
        .describe("Exact value override; omit or null to use the component's configured value."),
      runApplicability: z
        .enum(APPLICATIONS)
        .default("standard_runs")
        .describe(
          "standard_runs includes regular, supplemental, and termination runs; use regular_only or periodic_and_final for narrower eligibility.",
        ),
      effectiveFrom: DATE.describe("First date this assignment applies."),
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Last date this assignment applies, or null for no end date."),
      reason: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Reason recorded in the assignment audit."),
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
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const saved = await saveEmployeePayComponentAssignment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          employeePartyId: input.employeePartyId,
          employmentId: input.employmentId ?? null,
          componentId: input.componentId,
          value: input.value ?? null,
          runApplicability: input.runApplicability,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          reason: input.reason,
        });
        const read = await employeeAssignmentRead(
          context.authz.user.orgId,
          input.employeePartyId,
          context.authz.allowedSubsidiaryIds,
        );
        const assignment = read.assignments.find((row) => row.id === saved.id);
        if (!assignment) throw notFound("payroll assignment");
        return { ok: true, assignment, href: `/payroll?employee=${input.employeePartyId}` };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("record");
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "end_employee_pay_component_assignment",
    title: "End Employee Pay Component Assignment",
    description:
      "Set or clear the effective end date of an employee's recurring pay-component assignment. Get the assignment id and employee id from the employee payroll component read before changing its effective window.",
    inputSchema: z.object({
      id: UUID("Assignment id from the employee pay-component list."),
      employeePartyId: UUID("Employee party id that owns the assignment."),
      effectiveTo: DATE.nullable().describe("Inclusive last date, or null to clear the end date."),
      reason: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Reason recorded in the assignment audit."),
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
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        const saved = await endEmployeePayComponentAssignment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          id: input.id,
          effectiveTo: input.effectiveTo,
          reason: input.reason,
        });
        const read = await employeeAssignmentRead(
          context.authz.user.orgId,
          input.employeePartyId,
          context.authz.allowedSubsidiaryIds,
        );
        const assignment = read.assignments.find((row) => row.id === saved.id);
        if (!assignment) throw notFound("payroll assignment");
        return { ok: true, assignment, href: `/payroll?employee=${input.employeePartyId}` };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("record");
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_unused_employee_pay_component_assignment",
    title: "Delete Unused Employee Pay Component Assignment",
    description:
      "Delete an employee pay-component assignment only if it has never priced a pay stub; assignments already used in payroll must be ended. Find its id and employee with the employee pay-component read.",
    inputSchema: z.object({
      id: UUID("Assignment id from the employee pay-component list."),
      employeePartyId: UUID("Employee party id that owns the assignment."),
      reason: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe("Reason recorded in the assignment audit."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.manage");
      await assertPayrollEmployeeAccess(context, [input.employeePartyId]);
      try {
        await deleteUnusedEmployeePayComponentAssignment({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          id: input.id,
          reason: input.reason,
        });
        const read = await employeeAssignmentRead(
          context.authz.user.orgId,
          input.employeePartyId,
          context.authz.allowedSubsidiaryIds,
        );
        if (read.assignments.some((row) => row.id === input.id))
          throw invalidInput("The assignment still exists after deletion.");
        return { ok: true, ...read, href: `/payroll?employee=${input.employeePartyId}` };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("record");
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "create_payroll_remittance_bill",
    title: "Create Payroll Remittance Bill",
    description:
      "Create the draft vendor bill for an uncovered payroll remittance group and period; the remittance summary supplies the payee, filing account, dates and optional legal-entity slice. Verify the result in the Accounts Payable bills list.",
    inputSchema: z
      .object({
        partyId: UUID("Vendor party id from payroll_remittances."),
        filingAccountId: UUID(
          "Payroll filing account id from payroll_remittances, or omit when the group has no separate account.",
        )
          .nullable()
          .optional(),
        from: DATE.describe("Start of the remittance period."),
        to: DATE.describe("End of the remittance period."),
        subsidiaryId: UUID(
          "Legal-entity slice id from payroll_remittances, or omit to resolve the whole visible group.",
        )
          .nullable()
          .optional(),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => input.from <= input.to, {
        message: "The remittance period must start on or before it ends.",
        path: ["from"],
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      try {
        const bill = await createRemittanceBill(context.authz.user.orgId, context.authz.user.id, {
          partyId: input.partyId,
          from: input.from,
          to: input.to,
          filingAccountId: input.filingAccountId ?? null,
          subsidiaryId: input.subsidiaryId ?? null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...bill,
          status: "draft",
          href: `/ap/bills?documentId=${bill.documentId}`,
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_retro_pay",
    title: "Propose Retro Pay",
    description:
      "Quantify unpaid differences for committed pay periods after effective-dated payroll inputs changed, without creating a payable run. Find the schedule and employees in payroll setup and employee reads; review the returned periods before creating retro pay.",
    inputSchema: z.object({
      payScheduleId: UUID("Active pay schedule id from payroll setup."),
      payDate: DATE.describe(
        "Date the proposed retro run would pay, used to resolve the pack's statutory year.",
      ),
      employeePartyIds: z
        .array(UUID("Employee party id from list_payroll_employees."))
        .max(2000)
        .optional()
        .describe(
          "Limit the proposal to these employees; omitted means all employees in the caller's visible population.",
        ),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      try {
        const employeePartyIds = await scopedRetroEmployees(
          context.authz,
          input.payScheduleId,
          input.employeePartyIds?.length ? input.employeePartyIds : undefined,
        );
        const proposal = await proposeRetroPay({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          payScheduleId: input.payScheduleId,
          payDate: input.payDate,
          employeePartyIds,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, proposal, href: "/payroll/retro" };
      } catch (error) {
        if (error instanceof RetroScopeNotFound) throw notFound("record");
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "create_retro_pay_run",
    title: "Create Retro Pay Run",
    description:
      "Create the reviewed retro pay run for payable differences from committed source runs, preserving each source period and the pack-declared tax treatment. Review the proposal with propose_retro_pay first, then verify the created run with get_pay_run.",
    inputSchema: z.object({
      payScheduleId: UUID("Active pay schedule id from payroll setup."),
      payDate: DATE.describe("Date the retro run pays; its accounting period must be open."),
      employeePartyIds: z
        .array(UUID("Employee party id from the reviewed proposal."))
        .max(2000)
        .optional()
        .describe(
          "Employees included in the reviewed retro proposal; omitted means all visible employees with committed source runs.",
        ),
      excludeSourcePayRunDocumentIds: z
        .array(UUID("Source pay run document id from the proposal."))
        .max(2000)
        .optional()
        .describe("Reviewed source runs intentionally left unpaid by this retro run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    transactionIsolationLevel: "SERIALIZABLE",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, "payroll.run");
      try {
        const employeePartyIds = await scopedRetroEmployees(
          context.authz,
          input.payScheduleId,
          input.employeePartyIds?.length ? input.employeePartyIds : undefined,
        );
        const excludeSourcePayRunDocumentIds = input.excludeSourcePayRunDocumentIds?.length
          ? input.excludeSourcePayRunDocumentIds
          : undefined;
        await assertRetroExcludedSourcesInScope(
          context.authz,
          input.payScheduleId,
          excludeSourcePayRunDocumentIds,
        );
        const result = await createRetroPayRun({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          payScheduleId: input.payScheduleId,
          payDate: input.payDate,
          employeePartyIds,
          excludeSourcePayRunDocumentIds,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, status: "draft", href: `/payroll/runs/${result.documentId}` };
      } catch (error) {
        if (error instanceof RetroScopeNotFound) throw notFound("record");
        settlePayrollRefusal(error);
      }
    },
  }),
];
