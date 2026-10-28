import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
  type ApplicationContext,
} from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import type { ApplicationToolDefinition } from "./tool-definition";
import { definition } from "./tool-definition";
import {
  AllocationRunError,
  previewAllocationRun,
  postAllocationRun,
  rerunAllocationRun,
  reverseAllocationRun,
} from "@openbooks/engine/allocations/period-run";
import { allocationServiceDeps } from "@openbooks/engine/allocations/service";
import { getRun } from "@openbooks/engine/allocations/run-queries";
import {
  allocationScopeVisible,
  previewPinError,
} from "@openbooks/engine/organization/allocation-scope";
import { listAccountMerges } from "@openbooks/engine/chart/account-merge";
import {
  listIntercompanyFundTransfers,
  listNettingRuns,
  loadIntercompanyFundTransfer,
  loadNettingRun,
} from "@openbooks/engine/intercompany";
import {
  listCurrentTemplates,
  listScheduleRows,
  loadScheduleDetail,
} from "@openbooks/engine/amortization";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { db, withOrg } from "@openbooks/engine/platform/db";
import { readFxProviderConfigView } from "@openbooks/engine/fx/providers";
import { listFxProviderRuns } from "@openbooks/engine/fx/providers-read";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by a native list or read command.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const hasPermission = (permission: string) => (authz: ApplicationContext["authz"]) =>
  can(authz, permission);

function settleRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof Error) {
    const refusal = error as Error & {
      status?: unknown;
      code?: unknown;
      remedy?: unknown;
      details?: unknown;
    };
    if (typeof refusal.status === "number") {
      const details: Record<string, unknown> =
        typeof refusal.details === "object" && refusal.details !== null
          ? { ...(refusal.details as Record<string, unknown>) }
          : {};
      if (typeof refusal.code === "string") details.code = refusal.code;
      if (typeof refusal.remedy === "string") details.remedy = refusal.remedy;
      if (refusal.status === 403)
        throw new ApplicationError("forbidden", refusal.message, 403, details);
      if (refusal.status === 404)
        throw new ApplicationError("not_found", refusal.message, 404, details);
      if (refusal.status === 400)
        throw new ApplicationError("invalid_input", refusal.message, 400, details);
      if (refusal.status === 409) throw conflict(refusal.message, details);
      if (refusal.status === 429)
        throw new ApplicationError("rate_limited", refusal.message, 429, details);
      throw invalidInput(refusal.message, details);
    }
  }
  throw error;
}

function checkedAllocationRun(context: ApplicationContext, runId: string) {
  return withOrg(context.authz.user.orgId, () => getRun(context.authz.user.orgId, runId)).then(
    (run) => {
      if (
        !allocationScopeVisible(
          context.authz.allowedSubsidiaryIds,
          run.subsidiaryId,
          run.computation,
        )
      ) {
        throw notFound("allocation run");
      }
      return run;
    },
  );
}

export const LEDGER_OPERATIONS_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "run_allocation_rule",
    title: "Run Allocation Rule",
    description:
      "Compute and save a preview run for a published allocation rule, accounting period, and book; this does not post a journal. Find the ids with list_allocation_rules, the period list, and the accounting book list, then review the saved run with list_allocation_runs or explain_allocation.",
    inputSchema: z.object({
      ruleId: UUID.describe("Published allocation rule id from list_allocation_rules."),
      periodId: UUID.describe("Accounting period id for this allocation run."),
      bookId: UUID.describe("Accounting book id for this allocation run."),
      subsidiaryId: UUID.nullable()
        .optional()
        .describe("Optional legal-entity pin; restricted callers must provide an allowed id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("allocations.run"),
    featureKey: "allocations",
    execute: async (context, input) => {
      assertApplicationPermission(context, "allocations.run");
      const pinRefusal = previewPinError(
        context.authz.allowedSubsidiaryIds,
        input.subsidiaryId ?? null,
      );
      if (pinRefusal) {
        throw new ApplicationError("forbidden", pinRefusal, 403, {
          remedy: "Set subsidiaryId to a subsidiary within the caller's allowed scope.",
        });
      }
      try {
        const preview = await previewAllocationRun(
          {
            orgId: context.authz.user.orgId,
            ruleId: input.ruleId,
            periodId: input.periodId,
            bookId: input.bookId,
            subsidiaryId: input.subsidiaryId,
            actorId: context.authz.user.id,
            trigger: "manual",
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
          allocationServiceDeps(),
        );
        const run = await checkedAllocationRun(context, preview.id);
        return {
          ok: true,
          runId: run.id,
          status: run.status,
          computation: run.computation,
          href: `/admin/setup/allocations?tab=runs&run=${run.id}`,
        };
      } catch (error) {
        if (error instanceof AllocationRunError) {
          if (error.code === "NOT_FOUND") throw notFound("record");
          throw new ApplicationError("invalid_input", error.message, 422, { code: error.code });
        }
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "post_allocation_run",
    title: "Post Allocation Run",
    description:
      "Post a previewed allocation run after reviewing it with explain_allocation or list_allocation_runs. The run must be visible in your subsidiary scope and the caller needs allocation-run and journal-posting authority.",
    inputSchema: z.object({
      runId: UUID.describe("Previewed allocation run id from list_allocation_runs."),
      reason: z.string().trim().min(1).max(2000).describe("Posting reason recorded with the run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "allocations.run") && can(authz, "gl.post"),
    featureKey: "allocations",
    execute: async (context, input) => {
      assertApplicationPermission(context, "allocations.run");
      assertApplicationPermission(context, "gl.post");
      try {
        const prior = await checkedAllocationRun(context, input.runId);
        const run = await postAllocationRun(input.runId, context.authz.user.id, input.reason);
        return {
          ok: true,
          runId: run.id,
          status: run.status,
          journalEntryId: run.journalEntryId,
          href: `/admin/setup/allocations?tab=runs&run=${run.id}`,
          ...(prior.status === "pending_approval" ? { priorStatus: prior.status } : {}),
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "reverse_allocation_run",
    title: "Reverse Allocation Run",
    description:
      "Reverse a posted allocation run using its stored lines, preserving the original run and journal history. Find the run with list_allocation_runs and confirm its details with explain_allocation first.",
    inputSchema: z.object({
      runId: UUID.describe("Posted allocation run id from list_allocation_runs."),
      reason: z.string().trim().min(1).max(2000).describe("Reason recorded for the reversal."),
      reversalDate: DATE.optional().describe(
        "Reversal posting date; omitted uses the service business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "allocations.run") && can(authz, "gl.post"),
    featureKey: "allocations",
    execute: async (context, input) => {
      assertApplicationPermission(context, "allocations.run");
      assertApplicationPermission(context, "gl.post");
      try {
        await checkedAllocationRun(context, input.runId);
        const run = await reverseAllocationRun(input.runId, context.authz.user.id, input.reason, {
          reversalDate: input.reversalDate,
        });
        return {
          ok: true,
          runId: input.runId,
          reversalEntryId: run.reversalEntryId,
          status: "reversed",
          href: `/admin/setup/allocations?tab=runs&run=${input.runId}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "rerun_allocation_run",
    title: "Rerun Allocation Run",
    description:
      "Reverse a posted allocation run and compute a fresh run from the current rule and source balances. Find the original with list_allocation_runs; this action needs allocation-run and journal-posting authority.",
    inputSchema: z.object({
      runId: UUID.describe("Allocation run id from list_allocation_runs."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .optional()
        .describe("Audit reason; omitted uses the route's existing default."),
      reversalDate: DATE.optional().describe(
        "Reversal posting date; omitted uses the service default.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "allocations.run") && can(authz, "gl.post"),
    featureKey: "allocations",
    execute: async (context, input) => {
      assertApplicationPermission(context, "allocations.run");
      assertApplicationPermission(context, "gl.post");
      try {
        await checkedAllocationRun(context, input.runId);
        const result = await rerunAllocationRun(
          input.runId,
          context.authz.user.id,
          input.reason?.trim() || "Re-run requested from the Runs tab",
          { reversalDate: input.reversalDate },
        );
        return {
          ok: true,
          runId: result.run.id,
          status: result.run.status,
          href: "/admin/setup/allocations?tab=runs",
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "list_account_merges",
    title: "List Account Merges",
    description:
      "List completed account merges and pending proposals, optionally filtered to one account. Use the returned proposal id with apply_account_merge after approval.",
    inputSchema: z.object({
      accountId: UUID.optional().describe("Filter to a source or target account."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum rows to return (default 50)."),
      offset: z.number().int().min(0).optional().describe("Rows to skip."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("gl.manage"),
    featureKey: "accountMerges",
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.manage");
      const result = await listAccountMerges(
        context.authz.user.orgId,
        { accountId: input.accountId, limit: input.limit ?? 50, offset: input.offset ?? 0 },
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...result, href: "/accounts/merges" };
    },
  }),
  definition({
    name: "list_intercompany_netting_runs",
    title: "List Intercompany Netting Runs",
    description:
      "List netting runs whose entire subsidiary scope is visible to the caller. Use a returned run id with get_intercompany_netting_run before submit, post, cancel or reverse.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum rows to return (default 100)."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("intercompany.read"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.read");
      const runs = await listNettingRuns(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
        { limit: input.limit ?? 100 },
      );
      return { ok: true, runs, href: "/intercompany/netting" };
    },
  }),
  definition({
    name: "get_intercompany_netting_run",
    title: "Get Intercompany Netting Run",
    description:
      "Read one intercompany netting run with its stored calculation and settlement lines. The run must belong to the caller's organization and be fully within subsidiary scope.",
    inputSchema: z.object({ runId: UUID.describe("Run id from list_intercompany_netting_runs.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("intercompany.read"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.read");
      const run = await loadNettingRun(
        context.authz.user.orgId,
        input.runId,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, run, href: `/intercompany/netting?run=${input.runId}` };
    },
  }),
  definition({
    name: "list_intercompany_fund_transfers",
    title: "List Intercompany Fund Transfers",
    description:
      "List posted and reversed cash transfers where both subsidiaries are visible to the caller. Use a returned id with get_intercompany_fund_transfer before reversing.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum rows to return (default 100)."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("intercompany.read"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.read");
      const transfers = await listIntercompanyFundTransfers(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
        { limit: input.limit ?? 100 },
      );
      return { ok: true, transfers, href: "/intercompany/transfers" };
    },
  }),
  definition({
    name: "get_intercompany_fund_transfer",
    title: "Get Intercompany Fund Transfer",
    description:
      "Read one intercompany fund transfer and its posted or reversal entries. The transfer must belong to the caller's organization and both subsidiaries must be visible.",
    inputSchema: z.object({
      transferId: UUID.describe("Transfer id from list_intercompany_fund_transfers."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("intercompany.read"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.read");
      const transfer = await loadIntercompanyFundTransfer(
        context.authz.user.orgId,
        input.transferId,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, transfer, href: `/intercompany/transfers?transfer=${input.transferId}` };
    },
  }),
  definition({
    name: "list_amortization_schedules",
    title: "List Amortization Schedules",
    description:
      "List amortization schedules in the caller's subsidiary scope with balances and next planned period. Use a returned id with get_amortization_schedule before changing or running it.",
    inputSchema: z.object({
      status: z
        .enum(["open", "draft", "active", "on_hold", "completed", "cancelled"])
        .optional()
        .describe("Filter by lifecycle status; open includes draft, active and on hold."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Maximum rows to return (default 2000)."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("amortization.read"),
    featureKey: "expenseAmortization",
    execute: async (context, input) => {
      assertApplicationPermission(context, "amortization.read");
      const orgId = context.authz.user.orgId;
      const today = await businessToday(orgId);
      const rows = await withOrg(orgId, () =>
        listScheduleRows(db, orgId, {
          status: input.status ?? "open",
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          limit: input.limit,
        }),
      );
      const templates = can(context.authz, "amortization.manage")
        ? await withOrg(orgId, () => listCurrentTemplates(db, orgId, today))
        : undefined;
      return {
        ok: true,
        schedules: rows,
        ...(templates ? { templates } : {}),
        href: "/accounting/amortization",
      };
    },
  }),
  definition({
    name: "get_amortization_schedule",
    title: "Get Amortization Schedule",
    description:
      "Read one amortization schedule, including its plan, balances and governed change history. Find the schedule id with list_amortization_schedules.",
    inputSchema: z.object({
      scheduleId: UUID.describe("Schedule id from list_amortization_schedules."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("amortization.read"),
    featureKey: "expenseAmortization",
    execute: async (context, input) => {
      assertApplicationPermission(context, "amortization.read");
      try {
        const detail = await withOrg(context.authz.user.orgId, () =>
          loadScheduleDetail(db, context.authz.user.orgId, input.scheduleId),
        );
        assertSubsidiaryAccess(context, detail.schedule.subsidiaryId);
        return {
          ok: true,
          schedule: detail,
          href: `/accounting/amortization?schedule=${input.scheduleId}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "get_fx_provider_status",
    title: "Get FX Provider Status",
    description:
      "Read the configured FX provider without credentials, plus its recent synchronization runs. Use this before refresh_fx_provider or to verify a completed refresh.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("admin.setup.manage"),
    featureKey: "multiCurrency",
    execute: async (context) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const [config, runs] = await Promise.all([
        readFxProviderConfigView(context.authz.user.orgId),
        listFxProviderRuns(context.authz.user.orgId),
      ]);
      return { ok: true, config, runs, href: "/admin/setup/fx-provider" };
    },
  }),
];
