import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can, type Authz } from "../authz";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
  type ApplicationContext,
} from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import type { ApplicationToolDefinition } from "./tool-definition";
import { definition } from "./tool-definition";
import {
  activateSchedule,
  cancelSchedule,
  changeScheduleDestination,
  changeScheduleTerm,
  createManualSchedule,
  holdSchedule,
  reduceSchedule,
  resumeSchedule,
  runExpenseAmortization,
} from "@openbooks/engine/amortization";
import {
  isContinuousCloseAgentKey,
  runContinuousCloseAgent,
} from "@openbooks/engine/continuous-close/continuous-close";
import {
  AccountMergeError,
  applyApprovedAccountMerge,
  previewAccountMerge,
  requestAccountMerge,
} from "@openbooks/engine/chart/account-merge";
import {
  ConsolidationError,
  deriveConsolidatedRates,
  runAutoElimination,
  runCombinedConsolidation,
  runOwnershipConsolidation,
} from "@openbooks/engine/consolidation/consolidation";
import { runConsolidationGroup } from "@openbooks/engine/billing";
import {
  runScheduleCatchUp,
  runScheduleNow,
  RecurringError,
} from "@openbooks/engine/billing/recurring";
import {
  cancelNettingRun,
  postIntercompanyFundTransfer,
  postNettingRun,
  proposeNettingRun,
  reverseIntercompanyFundTransfer,
  reverseNettingRun,
  submitNettingRun,
} from "@openbooks/engine/intercompany";
import { updateCloseTask } from "@openbooks/engine/close/tasks";
import { CloseError } from "@openbooks/engine/periods/period-policy";
import {
  submitBudgetScenario,
  withdrawBudgetScenario,
} from "@openbooks/engine/flows/budget-submission";
import { BudgetApprovalError } from "@openbooks/engine/flows/budget-submission";
import {
  runFxProvider,
  saveFxProviderConfig,
  FxProviderError,
} from "@openbooks/engine/fx/providers";
import { withOrg, withOrgTransaction } from "@openbooks/engine/platform/db";
import { scenarioOutOfScopeSubsidiaryNames, outOfScopeScenarioError } from "../budget-scope";
import {
  deleteRecurringSchedule,
  pauseRecurringSchedule,
  RecurringScheduleActionRefusal,
  recurringSchedulePatchSchema,
  updateRecurringSchedule,
} from "../recurring/schedule-actions";
import { LEDGER_CONFIGURATION_TOOLS } from "./ledger-tools-configuration";
import { LEDGER_ALLOCATION_CONFIGURATION_TOOLS } from "./ledger-tools-allocation-config";
import { LEDGER_CONSOLIDATION_TOOLS } from "./ledger-tools-consolidation";
import { LEDGER_INTERCOMPANY_TOOLS } from "./ledger-tools-intercompany";
import { LEDGER_OPERATIONS_TOOLS } from "./ledger-tools-operations";
import { LEDGER_CLOSE_TOOLS } from "./ledger-tools-close";
import { LEDGER_METRICS_TOOLS } from "./ledger-tools-metrics";
import { LEDGER_BUDGET_ACTION_TOOLS } from "./ledger-tools-budget-actions";
import {
  canManageAnyContinuousCloseItem,
  updateContinuousCloseItem,
  type ContinuousCloseItemAction,
} from "../continuous-close/item-actions";
import {
  AccountGroupPinError,
  pinAccountToGroup,
  unpinAccountFromGroup,
} from "../account-groups/pins";
import {
  createRecurringSchedule,
  RecurringScheduleCreateRefusal,
  recurringScheduleCreateSchema,
} from "../recurring/create-schedule";
import { budgetScenarioCreateFields, createBudgetScenario } from "../budget-scenarios";
import { deleteDocument, DeleteError } from "@openbooks/engine/ledger/document-delete";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import {
  DocumentEditError,
  requireDocumentEditRevision,
} from "@openbooks/engine/records/document-edit-policy";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by a native list or read command.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date (YYYY-MM-DD).");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const MONEY = z
  .string()
  .regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal amount as a string; never a JSON number.");

const hasPermission = (permission: string) => (authz: Authz) => can(authz, permission);

function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

/** Preserve typed service refusals, including the domain's supported remedy. */
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

function settleAccountGroupPinRefusal(error: unknown): never {
  if (error instanceof AccountGroupPinError) {
    if (error.status === 404) throw notFound("account group or account");
    if (error.status === 403) throw forbidden("subsidiary.unrestricted");
  }
  throw error;
}

/** General ledger, accounting books, allocations, intercompany, consolidation, budgets and period close commands for the assistant, MCP and the v1 command API. */
export const LEDGER_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  ...LEDGER_ALLOCATION_CONFIGURATION_TOOLS,
  ...LEDGER_CONFIGURATION_TOOLS,
  ...LEDGER_CONSOLIDATION_TOOLS,
  ...LEDGER_INTERCOMPANY_TOOLS,
  ...LEDGER_OPERATIONS_TOOLS,
  ...LEDGER_CLOSE_TOOLS,
  ...LEDGER_METRICS_TOOLS,
  ...LEDGER_BUDGET_ACTION_TOOLS,
  definition({
    name: "create_recurring_schedule",
    title: "Create Recurring Schedule",
    description:
      "Create a recurring schedule from an existing document template. Find template ids with find_documents and existing schedules with list_recurring_schedules; auto-posting requires journal-posting authority, and a backlog requires an explicit catch-up choice.",
    inputSchema: recurringScheduleCreateSchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await withOrg(context.authz.user.orgId, () =>
          createRecurringSchedule(context.authz, body),
        );
        if (result.kind === "not_found") throw notFound("recurring template document");
        if (result.kind === "ambiguous")
          throw new ApplicationError(
            "invalid_input",
            "Document number is ambiguous; select a template ID.",
            400,
          );
        return {
          ok: true,
          scheduleId: result.id,
          status: result.isActive ? "active" : "inactive",
          ...(result.catchUp ? { catchUp: result.catchUp } : {}),
          href: "/collections",
        };
      } catch (error) {
        if (error instanceof RecurringScheduleCreateRefusal) {
          const details = {
            ...(error.code ? { code: error.code } : {}),
            ...(error.details ?? {}),
          };
          if (error.status === 403)
            throw new ApplicationError("forbidden", error.message, 403, details);
          if (error.status === 404)
            throw new ApplicationError("not_found", error.message, 404, details);
          if (error.status === 409) throw conflict(error.message, details);
          if (error.status === 400)
            throw new ApplicationError("invalid_input", error.message, 400, details);
          throw invalidInput(error.message, details);
        }
        if (error instanceof RecurringError) {
          if (error.status === 400) throw new ApplicationError("invalid_input", error.message, 400);
          settleRefusal(error);
        }
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_journal_draft",
    title: "Delete Journal Draft",
    description:
      "Delete an unposted journal draft that has no downstream dependencies. Find the journal and its exact revision with get_record (typeKey journals); submitted or posted journals must use their governed lifecycle.",
    inputSchema: z.object({
      documentId: UUID.describe("Journal document id from get_record with typeKey journals."),
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(64)
        .describe("Exact updated_at revision token returned by get_record with typeKey journals."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("gl.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      try {
        const expectedUpdatedAt = requireDocumentEditRevision(input.expectedUpdatedAt);
        const result = await deleteDocument(
          input.documentId,
          context.authz.user.id,
          context.authz.user.orgId,
          { expectedUpdatedAt, allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds },
        );
        return {
          ok: true,
          documentId: result.documentId,
          status: "deleted",
          href: "/journals",
        };
      } catch (error) {
        if (error instanceof ScopeNotFoundError) throw notFound("journal");
        if (error instanceof DocumentEditError) {
          throw new ApplicationError("conflict", error.message, error.status, {
            ...(error.remedy ? { remedy: error.remedy } : {}),
          });
        }
        if (error instanceof DeleteError) {
          if (error.status === 404) throw notFound("journal");
          if (error.status === 409) throw conflict(error.message);
          throw invalidInput(error.message);
        }
        throw error;
      }
    },
  }),
  definition({
    name: "pin_account_group",
    title: "Pin Account to Group",
    description:
      "Assign an account to a reporting group, moving any existing pin in the same dimension. Find account and group ids through the account register and account group setup views.",
    inputSchema: z.object({
      groupId: UUID.describe("Account group id from account group setup."),
      accountId: UUID.describe("Account id from the account register."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        await withOrg(context.authz.user.orgId, () =>
          pinAccountToGroup(context.authz, input.groupId, input.accountId),
        );
        return {
          ok: true,
          groupId: input.groupId,
          accountId: input.accountId,
          status: "pinned",
          href: "/admin/setup/account-groups",
        };
      } catch (error) {
        settleAccountGroupPinRefusal(error);
      }
    },
  }),
  definition({
    name: "unpin_account_group",
    title: "Unpin Account from Group",
    description:
      "Remove an account's explicit pin so the group rules classify it again. Find the account and group ids through the account register and account group setup views.",
    inputSchema: z.object({
      groupId: UUID.describe("Account group id from account group setup."),
      accountId: UUID.describe("Account id from the account register."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        const removed = await withOrg(context.authz.user.orgId, () =>
          unpinAccountFromGroup(context.authz, input.groupId, input.accountId),
        );
        return {
          ok: true,
          groupId: input.groupId,
          accountId: input.accountId,
          status: removed ? "unpinned" : "already_unpinned",
          href: "/admin/setup/account-groups",
        };
      } catch (error) {
        settleAccountGroupPinRefusal(error);
      }
    },
  }),
  definition({
    name: "run_recurring_schedule",
    title: "Run Recurring Schedule",
    description:
      "Generate the next document from an active recurring schedule, or process a named catch-up choice. Find schedule ids with list_recurring_schedules; auto-posting requires journal-posting authority.",
    inputSchema: z.object({
      scheduleId: UUID.describe("Schedule id from list_recurring_schedules."),
      catchUp: z
        .object({
          mode: z
            .enum(["post_all", "drafts", "skip", "selected"])
            .describe("How to resolve pending occurrences."),
          dates: z.array(DATE).max(1000).optional().describe("Occurrence dates for selected mode."),
          post: z
            .boolean()
            .optional()
            .describe("Post generated documents when the selected catch-up mode supports it."),
        })
        .optional()
        .describe("Catch-up decision; omitted runs one manual occurrence now."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      try {
        const result = input.catchUp
          ? await runScheduleCatchUp(context.authz.user.orgId, input.scheduleId, {
              mode: input.catchUp.mode,
              selectedDates: input.catchUp.dates,
              postSelected: input.catchUp.post,
              actorId: context.authz.user.id,
              allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            })
          : await runScheduleNow(
              context.authz.user.orgId,
              input.scheduleId,
              context.authz.user.id,
              undefined,
              {
                allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
                canPost: can(context.authz, "gl.post"),
              },
            );
        const documentId = "documentId" in result ? result.documentId : undefined;
        return {
          ok: true,
          ...result,
          ...(documentId ? { href: `/documents/${documentId}` } : { href: "/recurring" }),
        };
      } catch (error) {
        if (error instanceof RecurringError) settleRefusal(error);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "pause_recurring_schedule",
    title: "Pause Recurring Schedule",
    description:
      "Pause an active recurring schedule so the scheduler no longer generates its future documents. Find the schedule id with list_recurring_schedules; generated documents and schedule history remain available.",
    inputSchema: z.object({
      scheduleId: UUID.describe("Schedule id from list_recurring_schedules."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      const paused = await withOrg(context.authz.user.orgId, () =>
        pauseRecurringSchedule(context.authz, input.scheduleId),
      );
      if (!paused) throw notFound("recurring schedule");
      return { ok: true, scheduleId: input.scheduleId, href: "/collections" };
    },
  }),
  definition({
    name: "update_recurring_schedule",
    title: "Update Recurring Schedule",
    description:
      "Change an active or paused schedule's dates, posting behavior, limits, skipped occurrences, or name. Find the schedule id with list_recurring_schedules; resuming a backlog requires an explicit catch-up choice, and automatic posting requires journal-posting authority.",
    inputSchema: z.object({
      scheduleId: UUID.describe("Schedule id from list_recurring_schedules."),
      ...recurringSchedulePatchSchema.shape,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      const { scheduleId, idempotencyKey: _key, ...changes } = input;
      try {
        const result = await withOrg(context.authz.user.orgId, () =>
          updateRecurringSchedule(context.authz, scheduleId, changes),
        );
        if (!result) throw notFound("recurring schedule");
        return {
          ok: true,
          scheduleId,
          status: "updated",
          ...(result.catchUp ? { catchUp: result.catchUp } : {}),
          href: "/collections",
        };
      } catch (error) {
        if (error instanceof RecurringScheduleActionRefusal || error instanceof RecurringError)
          settleRefusal(error);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_recurring_schedule",
    title: "Delete Recurring Schedule",
    description:
      "Delete a schedule that has not generated documents. Find the schedule id with list_recurring_schedules; schedules with generated documents are retained to preserve immutable lineage.",
    inputSchema: z.object({
      scheduleId: UUID.describe("Schedule id from list_recurring_schedules."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("documents.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      const result = await withOrg(context.authz.user.orgId, () =>
        deleteRecurringSchedule(context.authz, input.scheduleId),
      );
      if (result === "not_found") throw notFound("recurring schedule");
      if (result === "generated_documents_exist") {
        throw conflict(
          "This recurring schedule cannot be deleted because generated documents exist; their immutable lineage must be preserved.",
          { code: "generated_documents_exist" },
        );
      }
      return {
        ok: true,
        scheduleId: input.scheduleId,
        status: "deleted",
        href: "/collections",
      };
    },
  }),
  definition({
    name: "create_manual_amortization_schedule",
    title: "Create Manual Amortization Schedule",
    description:
      "Record a carried-in prepaid balance as a draft amortization schedule; activation is a separate governed step. Use the amortization schedule list to find its template and subsidiary ids.",
    inputSchema: z.object({
      templateId: UUID.describe("Amortization template id."),
      subsidiaryId: UUID.describe("Owning subsidiary id."),
      bookId: UUID.nullable()
        .optional()
        .describe("Accounting book id; omitted follows the route's default."),
      totalAmount: MONEY,
      openingAmortizedAmount: MONEY.optional().describe(
        "Amount already amortized before this schedule.",
      ),
      serviceStartOn: DATE,
      serviceEndOn: DATE.nullable().optional().describe("Service end date, if known."),
      amortizeFromPeriod: DATE.nullable()
        .optional()
        .describe("First amortization period override."),
      destinationAccountId: UUID.nullable().optional().describe("Expense account override."),
      departmentId: UUID.nullable().optional().describe("Department dimension."),
      projectId: UUID.nullable().optional().describe("Project dimension."),
      locationId: UUID.nullable().optional().describe("Location dimension."),
      classId: UUID.nullable().optional().describe("Class dimension."),
      memo: z.string().max(500).nullable().optional().describe("Schedule memo."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(2000)
        .describe("Reason for recording the carried-in balance."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("amortization.manage"),
    featureKey: "expenseAmortization",
    execute: async (context, input) => {
      assertApplicationPermission(context, "amortization.manage");
      assertSubsidiaryAccess(context, input.subsidiaryId);
      try {
        const result = await createManualSchedule({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          templateId: input.templateId,
          subsidiaryId: input.subsidiaryId,
          bookId: input.bookId,
          totalAmount: input.totalAmount,
          openingAmortizedAmount: input.openingAmortizedAmount,
          serviceStartOn: input.serviceStartOn,
          serviceEndOn: input.serviceEndOn ?? null,
          amortizeFromPeriod: input.amortizeFromPeriod ?? null,
          destinationAccountId: input.destinationAccountId ?? null,
          dimensions: {
            departmentId: input.departmentId ?? null,
            projectId: input.projectId ?? null,
            locationId: input.locationId ?? null,
            classId: input.classId ?? null,
          },
          memo: input.memo ?? null,
          reason: input.reason,
        });
        return {
          ok: true,
          ...result,
          href: `/accounting/amortization?schedule=${result.scheduleId}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "change_amortization_schedule",
    title: "Change Amortization Schedule",
    description:
      "Apply a governed lifecycle or forecast change to a schedule, with a reason and optional revision check. Read the schedule detail first; posted plan lines remain immutable.",
    inputSchema: z.object({
      action: z
        .enum([
          "activate",
          "hold",
          "resume",
          "change_term",
          "change_destination",
          "reduce",
          "cancel",
        ])
        .describe("Governed schedule lifecycle or forecast action."),
      scheduleId: UUID.describe("Schedule id from get_amortization_schedule."),
      reason: z.string().trim().min(1).max(2000).describe("Business reason for the change."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Schedule revision reviewed."),
      effectivePeriod: DATE.optional().describe(
        "First period affected by a term or destination change.",
      ),
      newLastPeriod: DATE.optional().describe("New final period for change_term."),
      destinationAccountId: UUID.optional().describe("New expense account for change_destination."),
      amount: MONEY.optional().describe("Exact decimal reduction amount for reduce."),
      effectiveDate: DATE.optional().describe("Effective date for reduce or cancel."),
      relatedDocumentId: UUID.nullable()
        .optional()
        .describe("Credit or adjustment document id for reduce."),
      mode: z
        .enum(["reverse", "write_off"])
        .optional()
        .describe("How cancel resolves the remaining balance."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("amortization.manage"),
    featureKey: "expenseAmortization",
    execute: async (context, input) => {
      assertApplicationPermission(context, "amortization.manage");
      const base = {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        scheduleId: input.scheduleId,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
      };
      const required = <T>(value: T | undefined, field: string): T => {
        if (value === undefined) throw invalidInput(`${field} is required for ${input.action}.`);
        return value;
      };
      try {
        let result;
        switch (input.action) {
          case "activate":
            result = await activateSchedule(base);
            break;
          case "hold":
            result = await holdSchedule(base);
            break;
          case "resume":
            result = await resumeSchedule(base);
            break;
          case "change_term":
            result = await changeScheduleTerm({
              ...base,
              effectivePeriod: required(input.effectivePeriod, "effectivePeriod"),
              newLastPeriod: required(input.newLastPeriod, "newLastPeriod"),
            });
            break;
          case "change_destination":
            result = await changeScheduleDestination({
              ...base,
              effectivePeriod: required(input.effectivePeriod, "effectivePeriod"),
              destinationAccountId: required(input.destinationAccountId, "destinationAccountId"),
            });
            break;
          case "reduce":
            result = await reduceSchedule({
              ...base,
              amount: required(input.amount, "amount"),
              effectiveDate: required(input.effectiveDate, "effectiveDate"),
              relatedDocumentId: input.relatedDocumentId ?? null,
            });
            break;
          case "cancel":
            result = await cancelSchedule({
              ...base,
              mode: required(input.mode, "mode"),
              effectiveDate: required(input.effectiveDate, "effectiveDate"),
            });
            break;
        }
        return {
          ok: true,
          ...result,
          href: `/accounting/amortization?schedule=${input.scheduleId}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "run_expense_amortization",
    title: "Run Expense Amortization",
    description:
      "Post due planned amortization entries through a period end or as-of date, optionally for selected schedules. Read schedule details before the run; the native run reports each schedule's posted entries and refusals.",
    inputSchema: z
      .object({
        periodId: UUID.optional().describe("Accounting period id; choose this or asOf."),
        asOf: DATE.optional().describe("Cutoff date; choose this or periodId."),
        scheduleIds: z
          .array(UUID)
          .max(500)
          .optional()
          .describe("Limit the run to these schedules."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => (input.periodId !== undefined) !== (input.asOf !== undefined), {
        message: "Name exactly one of periodId or asOf.",
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("amortization.manage"),
    featureKey: "expenseAmortization",
    execute: async (context, input) => {
      assertApplicationPermission(context, "amortization.manage");
      if (input.scheduleIds && context.authz.allowedSubsidiaryIds !== null) {
        // The engine filters the run by the actor's authoritative role scope.
        // This additional check refuses unknown schedule identity before execution.
        if (input.scheduleIds.length === 0)
          throw invalidInput("Provide at least one schedule id or omit scheduleIds.");
      }
      try {
        const result = await runExpenseAmortization({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          periodId: input.periodId ?? null,
          asOf: input.asOf ?? null,
          scheduleIds: input.scheduleIds,
        });
        return { ok: true, ...result, href: "/accounting/amortization" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "preview_account_merge",
    title: "Preview Account Merge",
    description:
      "Show every refusal and consequence before merging a source account into a surviving account. Find accounts with find_accounts; the returned digest must be passed unchanged to propose_account_merge.",
    inputSchema: z.object({
      sourceAccountId: UUID.describe("Account to merge into the survivor."),
      targetAccountId: UUID.describe("Surviving account id."),
      effectiveDate: DATE,
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("gl.manage"),
    featureKey: "accountMerges",
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.manage");
      assertUnrestricted(context);
      try {
        const preview = await previewAccountMerge(
          context.authz.user.orgId,
          input,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...preview, href: `/accounts/${input.sourceAccountId}` };
      } catch (error) {
        if (error instanceof AccountMergeError) settleRefusal(error);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_account_merge",
    title: "Propose Account Merge",
    description:
      "Merge a source account into a surviving account, or submit the reviewed proposal for approval when an accounting flow requires it. Run preview_account_merge first and pass its current digest; accountMerges must be enabled.",
    inputSchema: z.object({
      sourceAccountId: UUID.describe("Account to merge."),
      targetAccountId: UUID.describe("Surviving account."),
      effectiveDate: DATE,
      expectedDigest: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .describe("Digest returned by preview_account_merge."),
      reason: z.string().trim().min(8).max(1000).describe("Business reason for the merge."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "gl.manage") && can(authz, "gl.post"),
    featureKey: "accountMerges",
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.manage");
      assertApplicationPermission(context, "gl.post");
      assertUnrestricted(context);
      try {
        const result = await requestAccountMerge(context.authz.user.orgId, {
          ...input,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: "/accounts/merges" };
      } catch (error) {
        if (error instanceof AccountMergeError) settleRefusal(error);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "apply_account_merge",
    title: "Apply Account Merge",
    description:
      "Apply an approved account merge proposal after its preview remains unchanged. Find the proposal through the account merge history or approval worklist; the command posts governed reclassification journals.",
    inputSchema: z.object({
      changeId: UUID.describe("Approved account merge change id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "gl.manage") && can(authz, "gl.post"),
    featureKey: "accountMerges",
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.manage");
      assertApplicationPermission(context, "gl.post");
      assertUnrestricted(context);
      try {
        const result = await applyApprovedAccountMerge(context.authz.user.orgId, {
          changeId: input.changeId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: "/accounts/merges" };
      } catch (error) {
        if (error instanceof AccountMergeError) settleRefusal(error);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_intercompany_netting",
    title: "Propose Intercompany Netting",
    description:
      "Create a fingerprinted netting proposal for selected subsidiaries and an as-of date. Use the intercompany workspace reads to verify balances and identifiers; submit the proposal separately for approval.",
    inputSchema: z.object({
      asOfDate: DATE,
      subsidiaryIds: z
        .array(UUID)
        .min(2)
        .max(50)
        .describe("Subsidiaries included in the netting run."),
      settleCash: z.boolean().describe("Whether to settle the residual by cash."),
      bankAccounts: z
        .record(
          UUID,
          z.record(
            z
              .string()
              .regex(/^[A-Z]{3}$/)
              .describe("ISO currency code."),
            UUID,
          ),
        )
        .optional()
        .describe("Bank accounts keyed by subsidiary id and currency when settling cash."),
      reason: z.string().trim().max(2000).describe("Reason for the proposal."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("intercompany.manage"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.manage");
      try {
        const { idempotencyKey: _key, ...proposal } = input;
        const result = await proposeNettingRun(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          proposal,
        );
        return { ok: true, ...result, href: `/intercompany/netting?run=${result.id}` };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  ...(["submit", "post", "cancel", "reverse"] as const).map((action) => {
    const metadata = {
      submit: ["submit_intercompany_netting", "Submit Intercompany Netting", "intercompany.manage"],
      post: ["post_intercompany_netting", "Post Intercompany Netting", "intercompany.settle"],
      cancel: ["cancel_intercompany_netting", "Cancel Intercompany Netting", "intercompany.manage"],
      reverse: [
        "reverse_intercompany_netting",
        "Reverse Intercompany Netting",
        "intercompany.settle",
      ],
    } as const;
    return definition({
      name: metadata[action][0],
      title: metadata[action][1],
      description: `${metadata[action][1]} through the native intercompany approval and posting lifecycle. Find the run in the intercompany netting workspace; it must be in the state required for this action.`,
      inputSchema: z.object({
        runId: UUID.describe("Intercompany netting run id."),
        ...(action === "cancel"
          ? { reason: z.string().trim().min(1).max(2000).describe("Reason for cancellation.") }
          : {}),
        ...(action === "reverse"
          ? {
              reason: z.string().trim().min(1).max(2000).describe("Reason for reversal."),
              reversalDate: DATE.describe("Reversal date (YYYY-MM-DD)."),
            }
          : {}),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      readOnly: false,
      destructive: action === "cancel" || action === "reverse",
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: hasPermission(metadata[action][2]),
      featureKey: "intercompanyNetting",
      execute: async (context, input) => {
        assertApplicationPermission(context, metadata[action][2]);
        try {
          let result;
          if (action === "submit")
            result = await submitNettingRun(
              context.authz.user.orgId,
              context.authz.user.id,
              input.runId,
              context.authz.allowedSubsidiaryIds,
            );
          else if (action === "post")
            result = await postNettingRun(
              context.authz.user.orgId,
              context.authz.user.id,
              input.runId,
              context.authz.allowedSubsidiaryIds,
            );
          else if (action === "cancel") {
            const reason = typeof input.reason === "string" ? input.reason : undefined;
            if (reason === undefined) throw invalidInput("A cancellation reason is required.");
            result = await cancelNettingRun(
              context.authz.user.orgId,
              context.authz.user.id,
              input.runId,
              reason,
              context.authz.allowedSubsidiaryIds,
            );
          } else {
            const reason = typeof input.reason === "string" ? input.reason : undefined;
            const reversalDate =
              typeof input.reversalDate === "string" ? input.reversalDate : undefined;
            if (reason === undefined || reversalDate === undefined)
              throw invalidInput("A reversal reason and date are required.");
            result = await reverseNettingRun(
              context.authz.user.orgId,
              context.authz.user.id,
              input.runId,
              { reason, reversalDate },
              context.authz.allowedSubsidiaryIds,
            );
          }
          return { ok: true, ...result, href: `/intercompany/netting?run=${input.runId}` };
        } catch (error) {
          settleRefusal(error);
        }
      },
    });
  }),
  definition({
    name: "post_intercompany_fund_transfer",
    title: "Post Intercompany Fund Transfer",
    description:
      "Post a cash transfer between two subsidiaries using their bank accounts and intercompany due-to/due-from legs. The transfer date, accounts, currency, exact amount and reason must be explicit.",
    inputSchema: z.object({
      transferDate: DATE,
      fromSubsidiaryId: UUID,
      toSubsidiaryId: UUID,
      fromBankAccountId: UUID,
      toBankAccountId: UUID,
      amount: MONEY,
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional()
        .describe("ISO currency code, if specified."),
      memo: z.string().max(500).nullable().optional().describe("Transfer memo."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for the transfer."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("intercompany.settle"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.settle");
      try {
        const { idempotencyKey: _key, ...transfer } = input;
        const result = await postIntercompanyFundTransfer(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          transfer,
        );
        return { ok: true, ...result, href: `/intercompany/transfers/${result.id}` };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "reverse_intercompany_fund_transfer",
    title: "Reverse Intercompany Fund Transfer",
    description:
      "Reverse a posted intercompany cash transfer on a stated date, with the original history preserved. Find the transfer in the intercompany workspace and provide a reason.",
    inputSchema: z.object({
      transferId: UUID.describe("Posted transfer id."),
      reversalDate: DATE,
      reason: z.string().trim().min(1).max(2000).describe("Reason for reversal."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("intercompany.settle"),
    featureKey: "intercompanyNetting",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.settle");
      try {
        const result = await reverseIntercompanyFundTransfer(
          context.authz.user.orgId,
          context.authz.user.id,
          input.transferId,
          { reversalDate: input.reversalDate, reason: input.reason },
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, ...result, href: `/intercompany/transfers/${input.transferId}` };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "run_consolidation",
    title: "Run Consolidation",
    description:
      "Derive rates, post ownership adjustments, run auto-eliminations, or execute the combined period consolidation. Use the consolidation view to identify the period; the combined action is atomic.",
    inputSchema: z.object({
      action: z
        .enum(["derive-rates", "ownership", "eliminate", "consolidate"])
        .describe("Consolidation phase to execute."),
      periodId: UUID.describe("Accounting period id from the period or consolidation read."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiSubsidiary",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      if (context.authz.allowedSubsidiaryIds !== null) throw notFound("record");
      try {
        let result: Record<string, unknown>;
        if (input.action === "derive-rates")
          result = {
            written: await withOrgTransaction(context.authz.user.orgId, () =>
              deriveConsolidatedRates(
                context.authz.user.orgId,
                input.periodId,
                context.authz.user.id,
              ),
            ),
          };
        else if (input.action === "ownership")
          result = await runOwnershipConsolidation(
            context.authz.user.orgId,
            input.periodId,
            context.authz.user.id,
          );
        else if (input.action === "eliminate")
          result = await runAutoElimination(
            context.authz.user.orgId,
            input.periodId,
            context.authz.user.id,
          );
        else
          result = await runCombinedConsolidation(
            context.authz.user.orgId,
            input.periodId,
            context.authz.user.id,
          );
        return {
          ok: true,
          ...result,
          action: input.action,
          href: "/close",
        };
      } catch (error) {
        if (error instanceof ConsolidationError) {
          throw invalidInput(error.message, { code: error.code });
        }
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "run_consolidated_billing",
    title: "Run Consolidated Billing",
    description:
      "Run billing for a consolidation group over an explicit date range, optionally posting generated invoices. Find group ids in the consolidated billing workspace; restricted subsidiary callers are refused.",
    inputSchema: z.object({
      groupId: UUID.describe("Consolidation group id."),
      periodStart: DATE,
      periodEnd: DATE,
      autoPost: z
        .boolean()
        .optional()
        .describe("Post generated invoices after creation; default false."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("documents.manage"),
    featureKey: "consolidatedBilling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "documents.manage");
      assertUnrestricted(context);
      try {
        const runs = await runConsolidationGroup(
          context.authz.user.orgId,
          input.groupId,
          input.periodStart,
          input.periodEnd,
          {
            actorId: context.authz.user.id,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
            autoPost: input.autoPost ?? false,
          },
        );
        return { ok: true, runs, href: "/billing/consolidation" };
      } catch (error) {
        if (error instanceof Error && error.message === "feature_disabled") {
          throw conflict(
            "Consolidated Billing is disabled. Enable it in Company Settings → Features.",
          );
        }
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "run_continuous_close_agent",
    title: "Run Continuous Close Agent",
    description:
      "Run a named continuous-close scan across the organization; its findings are available from the continuous-close workspace. Choose an agent key supported by the module and use an unrestricted close administrator.",
    inputSchema: z.object({
      agentKey: z
        .string()
        .min(1)
        .max(80)
        .refine(isContinuousCloseAgentKey, "Unsupported continuous-close agent.")
        .describe("Continuous-close agent key."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.ai.manage"),
    featureKey: "continuousClose",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.ai.manage");
      assertUnrestricted(context);
      try {
        const result = await runContinuousCloseAgent({
          orgId: context.authz.user.orgId,
          agentKey: input.agentKey as never,
          trigger: "manual",
          initiatedBy: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: "/continuous-close" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "update_continuous_close_item",
    title: "Update Continuous Close Item",
    description:
      "Review, resolve, dismiss, reopen, assign or add a note to a continuous-close finding. Find the item id with the continuous-close work-item reads; the finding’s agent and subject must be visible to the caller.",
    inputSchema: z.object({
      action: z
        .enum(["review", "resolve", "dismiss", "reopen", "assign", "note"])
        .describe("Finding action."),
      itemId: UUID.describe("Work item id from a continuous-close read."),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe("Reason required when dismissing the finding."),
      assigneeUserId: UUID.nullable()
        .optional()
        .describe("Organization user id, or null to clear the user assignee."),
      assigneeRole: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Organization role key, or null to clear the role assignee."),
      dueAt: z
        .string()
        .max(80)
        .nullable()
        .optional()
        .describe("Assignment due timestamp, or null to clear it."),
      body: z.string().max(4000).optional().describe("Note text when action is note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageAnyContinuousCloseItem,
    featureKey: "continuousClose",
    execute: async (context, input) => {
      assertApplicationPermission(context, "assistant.write");
      const { itemId, idempotencyKey: _key, action } = input;
      let nativeAction: ContinuousCloseItemAction;
      if (action === "assign") {
        nativeAction = {
          action,
          assigneeUserId: input.assigneeUserId,
          assigneeRole: input.assigneeRole,
          dueAt: input.dueAt,
        };
      } else if (action === "note") {
        if (input.body === undefined) throw invalidInput("A note body is required.");
        nativeAction = { action, body: input.body };
      } else {
        nativeAction = { action, reason: input.reason };
      }
      const result = await withOrg(context.authz.user.orgId, () =>
        updateContinuousCloseItem(context.authz, itemId, nativeAction),
      );
      if (!result.ok) {
        if (result.status === 404) throw notFound("continuous-close item");
        if (result.status === 403) throw forbidden("assistant.write");
        if (result.status === 409) throw conflict(result.error);
        throw invalidInput(result.error);
      }
      return {
        ok: true,
        itemId,
        ...(result.status ? { status: result.status } : {}),
        ...(result.id ? { noteId: result.id } : {}),
        href: `/continuous-close/items/${itemId}`,
      };
    },
  }),
  definition({
    name: "update_close_task",
    title: "Update Close Task",
    description:
      "Start, submit, complete or waive a task inside a validated close run. Find run and task ids with list_close_runs or get_close_run; the task must allow the requested transition.",
    inputSchema: z.object({
      runId: UUID.describe("Validated close run id."),
      taskId: UUID.describe("Task id from the close run."),
      action: z
        .enum(["start", "submit", "complete", "waive"])
        .describe("Requested close-task transition."),
      notes: z.string().max(2000).optional().describe("Optional note recorded on the task."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "continuousClose",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      assertUnrestricted(context);
      try {
        await updateCloseTask({
          orgId: context.authz.user.orgId,
          runId: input.runId,
          taskId: input.taskId,
          actorId: context.authz.user.id,
          action: input.action,
          notes: input.notes,
        });
        return {
          ok: true,
          runId: input.runId,
          taskId: input.taskId,
          href: `/close/runs/${input.runId}`,
        };
      } catch (error) {
        if (error instanceof CloseError) throw invalidInput(error.message);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "create_budget_scenario",
    title: "Create Budget Scenario",
    description:
      "Create a draft budget or forecast version, optionally copying visible lines from another scenario. Use list_budget_scenarios or get_budget_scenario to review existing versions and obtain source ids; the returned draft can be edited with update_budget_cells and submitted for approval.",
    inputSchema: z
      .object({
        ...budgetScenarioCreateFields.shape,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine((input) => Object.keys(input).some((key) => key !== "idempotencyKey"), {
        message: "At least one scenario field must be provided.",
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("budgets.manage"),
    featureKey: "budgets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "budgets.manage");
      const { idempotencyKey: _key, ...body } = input;
      try {
        const scenario = await withOrg(context.authz.user.orgId, () =>
          createBudgetScenario(context.authz, body),
        );
        return {
          ok: true,
          scenarioId: scenario.id,
          revision: scenario.revision,
          status: "draft",
          href: `/budgets?scenario=${scenario.id}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  ...(["submit", "withdraw"] as const).map((action) =>
    definition({
      name: `${action}_budget_scenario`,
      title: `${action === "submit" ? "Submit" : "Withdraw"} Budget Scenario`,
      description: `${action === "submit" ? "Submit a draft budget scenario" : "Withdraw a submitted budget scenario"} through the native revision-checked approval workflow. Find the scenario and current revision with get_budget_scenario.`,
      inputSchema: z.object({
        scenarioId: UUID.describe("Budget scenario id from list_budget_scenarios."),
        expectedRevision: z
          .number()
          .int()
          .positive()
          .describe("Current scenario revision from get_budget_scenario."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      readOnly: false,
      destructive: action === "withdraw",
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: hasPermission("budgets.manage"),
      featureKey: "budgets",
      execute: async (context, input) => {
        assertApplicationPermission(context, "budgets.manage");
        try {
          const outOfScope = await scenarioOutOfScopeSubsidiaryNames(
            input.scenarioId,
            context.authz.user.orgId,
            context.authz.allowedSubsidiaryIds,
          );
          if (outOfScope.length > 0) throw outOfScopeScenarioError(outOfScope);
          const result =
            action === "submit"
              ? await submitBudgetScenario(
                  context.authz.user.orgId,
                  context.authz.user.id,
                  input.scenarioId,
                  input.expectedRevision,
                )
              : await withdrawBudgetScenario(
                  context.authz.user.orgId,
                  context.authz.user.id,
                  input.scenarioId,
                  input.expectedRevision,
                );
          return {
            ok: true,
            ...result,
            scenarioId: input.scenarioId,
            status: action === "submit" ? "submitted" : "draft",
            href: `/budgets?scenario=${input.scenarioId}`,
          };
        } catch (error) {
          if (error instanceof BudgetApprovalError) settleRefusal(error);
          settleRefusal(error);
        }
      },
    }),
  ),
  definition({
    name: "configure_fx_provider",
    title: "Configure FX Provider",
    description:
      "Save the organization’s foreign exchange provider, currencies and refresh schedule. Use get_fx_provider_status to review the current configuration first; credentials are stored by the native provider service.",
    inputSchema: z.object({
      provider: z
        .enum(["bank_of_canada", "ecb", "open_exchange_rates"])
        .describe("Supported FX provider."),
      displayName: z.string().trim().min(1).max(100).describe("Provider name shown in settings."),
      baseCurrency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Base currency as an ISO 4217 code."),
      currencies: z
        .array(z.string().regex(/^[A-Z]{3}$/))
        .min(1)
        .max(200)
        .describe("Currencies to synchronize."),
      schedule: z
        .enum(["manual", "daily", "weekdays", "weekly"])
        .describe("Synchronization schedule."),
      syncHourUtc: z.number().int().min(0).max(23).describe("Scheduled UTC hour."),
      lookbackDays: z.number().int().min(0).max(3650).describe("Historical days to refresh."),
      isEnabled: z.boolean().describe("Whether scheduled synchronization is enabled."),
      apiKey: z
        .string()
        .nullable()
        .optional()
        .describe("Provider API key when the selected provider requires one."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    featureKey: "multiCurrency",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        const id = await saveFxProviderConfig(context.authz.user.orgId, context.authz.user.id, {
          provider: input.provider,
          displayName: input.displayName,
          baseCurrency: input.baseCurrency,
          currencies: input.currencies,
          schedule: input.schedule,
          syncHourUtc: input.syncHourUtc,
          lookbackDays: input.lookbackDays,
          isEnabled: input.isEnabled,
          apiKey: input.apiKey,
        });
        return { ok: true, id, href: "/admin/setup/fx-provider" };
      } catch (error) {
        if (error instanceof FxProviderError) throw invalidInput(error.message);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "test_fx_provider",
    title: "Test FX Provider",
    description:
      "Test connectivity using the saved FX provider configuration before scheduling refreshes. Configure the provider first with configure_fx_provider; inspect the result in get_fx_provider_status.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    featureKey: "multiCurrency",
    execute: async (context) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        const result = await runFxProvider(context.authz.user.orgId, "test", context.authz.user.id);
        return { ok: true, ...result, href: "/admin/setup/fx-provider" };
      } catch (error) {
        if (error instanceof FxProviderError) throw invalidInput(error.message);
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "refresh_fx_provider",
    title: "Refresh FX Provider",
    description:
      "Synchronize configured exchange rates from the enabled FX provider. Configure the provider first in FX settings; use the FX provider runs read to confirm the result.",
    inputSchema: z.object({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: hasPermission("admin.setup.manage"),
    featureKey: "multiCurrency",
    execute: async (context) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        const result = await runFxProvider(
          context.authz.user.orgId,
          "manual",
          context.authz.user.id,
        );
        return { ok: true, ...result, href: "/admin/setup/currencies?tab=providers" };
      } catch (error) {
        if (error instanceof FxProviderError) throw invalidInput(error.message);
        settleRefusal(error);
      }
    },
  }),
];
