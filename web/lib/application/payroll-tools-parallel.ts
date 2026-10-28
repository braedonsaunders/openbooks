import {
  comparablePayRuns,
  comparableSlots,
  listParallelRunScope,
  parallelComparisons,
  parallelTolerances,
  priorRegisters,
  runParallelComparison,
  suggestedPayRunForRegister,
  parallelRunInputsInScope,
  saveParallelTolerance,
  deleteParallelTolerance,
  deletePriorRegister,
  PriorRegisterNotFoundError,
} from "@openbooks/engine/payroll/parallel-run-store";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertPayrollActor,
  assertPayrollUnrestrictedScope,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
  UUID,
} from "./payroll-tools-common";
import { z } from "zod";

const TOLERANCE_KINDS = [
  "earning",
  "deduction",
  "employer_contribution",
  "credit",
  "total",
] as const;
const SCOPE = { read: "payroll.read", manage: "payroll.manage" } as const;

export const PAYROLL_PARALLEL_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_payroll_parallel_run_inputs",
    title: "List Payroll Parallel Run Inputs",
    description:
      "List visible prior-payroll registers, comparable pay runs, comparison results, and pack-derived comparison slots. Use this before comparing a run or changing a tolerance to find the ids and current state.",
    inputSchema: z.object({
      registerId: UUID("Optional register id to filter prior comparisons.").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: payrollActor(SCOPE.read),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, SCOPE.read);
      try {
        const { registerIds, runIds, comparisonIds } = await listParallelRunScope(
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds,
        );
        const [registers, runs, comparisons, tolerances, slots] = await Promise.all([
          priorRegisters(context.authz.user.orgId),
          comparablePayRuns(context.authz.user.orgId),
          parallelComparisons(context.authz.user.orgId, { registerId: input.registerId }),
          parallelTolerances(context.authz.user.orgId),
          comparableSlots(context.authz.user.orgId),
        ]);
        const suggested = input.registerId
          ? await suggestedPayRunForRegister(context.authz.user.orgId, input.registerId)
          : null;
        return {
          ok: true,
          registers:
            registerIds === null ? registers : registers.filter((row) => registerIds.has(row.id)),
          runs: runIds === null ? runs : runs.filter((row) => runIds.has(row.documentId)),
          comparisons:
            comparisonIds === null
              ? comparisons
              : comparisons.filter((row) => comparisonIds.has(row.id)),
          tolerances,
          slots: slots.map(({ fieldKey, kind, slot, label }) => ({ fieldKey, kind, slot, label })),
          suggestedRun:
            suggested &&
            (runIds === null || runIds.has(suggested)) &&
            (registerIds === null || registerIds.has(input.registerId ?? ""))
              ? suggested
              : null,
          href: "/payroll/parallel-run",
        };
      } catch (error) {
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "compare_payroll_parallel_run",
    title: "Compare Payroll Parallel Run",
    description:
      "Run and file an auditable comparison between an imported prior-provider register and a committed pay run. Find visible register and pay-run ids with list_payroll_parallel_run_inputs; the pay run must be eligible for comparison.",
    inputSchema: z.object({
      registerId: UUID("Register id from list_payroll_parallel_run_inputs."),
      payRunDocumentId: UUID(
        "Committed pay-run document id from list_payroll_parallel_run_inputs.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor(SCOPE.manage),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, SCOPE.manage);
      try {
        if (
          !(await parallelRunInputsInScope(
            context.authz.user.orgId,
            context.authz.allowedSubsidiaryIds,
            input.registerId,
            input.payRunDocumentId,
          ))
        )
          throw new ApplicationError("not_found", "Payroll comparison input was not found", 404);
        const result = await runParallelComparison({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          registerId: input.registerId,
          payRunDocumentId: input.payRunDocumentId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          comparisonId: result.comparisonId,
          comparison: result.comparison,
          href: `/payroll/parallel-run?comparisonId=${result.comparisonId}`,
        };
      } catch (error) {
        if (error instanceof PayrollError)
          throw new ApplicationError("conflict", error.message, 422);
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "set_payroll_parallel_tolerance",
    title: "Set Payroll Parallel Tolerance",
    description:
      "Save a reasoned exact-decimal tolerance for a pack-derived comparison slot. Find valid kinds and slots and the current values with list_payroll_parallel_run_inputs; organization-wide configuration requires unrestricted subsidiary access.",
    inputSchema: z.object({
      kind: z
        .enum(TOLERANCE_KINDS)
        .describe("Comparison component kind from the native slot list."),
      slot: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("Comparison slot key from list_payroll_parallel_run_inputs."),
      tolerance: z
        .string()
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .describe("Non-negative exact decimal tolerance."),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Audit reason for changing the comparison tolerance."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor(SCOPE.manage),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, SCOPE.manage);
      assertPayrollUnrestrictedScope(context);
      try {
        const normalized = canonicalDecimal(input.tolerance, 4);
        if (normalized === null)
          throw new ApplicationError(
            "invalid_input",
            "Tolerance must be a valid non-negative decimal with at most four places",
            422,
          );
        let tolerance: string;
        try {
          tolerance = normalizeMoney(normalized);
        } catch {
          throw new ApplicationError(
            "invalid_input",
            "Tolerance is out of range for the ledger",
            422,
          );
        }
        await saveParallelTolerance({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          kind: input.kind,
          slot: input.slot.trim(),
          tolerance,
          reason: input.reason.trim(),
        });
        return {
          ok: true,
          tolerances: await parallelTolerances(context.authz.user.orgId),
          href: "/payroll/parallel-run",
        };
      } catch (error) {
        if (error instanceof PayrollError)
          throw new ApplicationError("conflict", error.message, 422);
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_payroll_parallel_tolerance",
    title: "Delete Payroll Parallel Tolerance",
    description:
      "Remove a configured tolerance so the comparison slot returns to exact matching. Read list_payroll_parallel_run_inputs first to confirm the kind and slot; organization-wide configuration requires unrestricted subsidiary access.",
    inputSchema: z.object({
      kind: z
        .enum(TOLERANCE_KINDS)
        .describe("Comparison component kind from the native slot list."),
      slot: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .describe("Configured slot key from list_payroll_parallel_run_inputs."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor(SCOPE.manage),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, SCOPE.manage);
      assertPayrollUnrestrictedScope(context);
      try {
        await deleteParallelTolerance(
          context.authz.user.orgId,
          input.kind,
          input.slot,
          context.authz.user.id,
        );
        return {
          ok: true,
          tolerances: await parallelTolerances(context.authz.user.orgId),
          href: "/payroll/parallel-run",
        };
      } catch (error) {
        if (error instanceof PayrollError)
          throw new ApplicationError("conflict", error.message, 422);
        settlePayrollRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_payroll_prior_register",
    title: "Delete Payroll Prior Register",
    description:
      "Discard an imported prior-provider register and its comparison evidence when the source was imported incorrectly. Read list_payroll_parallel_run_inputs to find the register id and verify it is gone afterward.",
    inputSchema: z.object({
      registerId: UUID("Prior register id from list_payroll_parallel_run_inputs."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor(SCOPE.manage),
    featureKey: "payroll",
    execute: async (context, input) => {
      await assertPayrollActor(context, SCOPE.manage);
      try {
        await deletePriorRegister(
          context.authz.user.orgId,
          input.registerId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
        );
        if (
          (await priorRegisters(context.authz.user.orgId)).some(
            (row) => row.id === input.registerId,
          )
        )
          throw new ApplicationError(
            "internal_error",
            "Payroll prior register was not removed",
            500,
          );
        return { ok: true, id: input.registerId, href: "/payroll/parallel-run" };
      } catch (error) {
        if (error instanceof PriorRegisterNotFoundError) throw notFound("payroll prior register");
        if (error instanceof PayrollError)
          throw new ApplicationError("conflict", error.message, 422);
        settlePayrollRefusal(error);
      }
    },
  }),
];
