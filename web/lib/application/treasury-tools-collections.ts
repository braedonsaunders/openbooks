import "server-only";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { can } from "../authz";
import { arPosition } from "../cash/ar-position";
import { analyticsConfig } from "../analytics/config";
import { ANALYTICS_CONFIG } from "../analytics/config-spec";
import { normalizeMoneyValue } from "../cash/core";
import { enqueueStatementBatchJobs } from "@openbooks/jobs";
import {
  createStatementBatchRun,
  getStatementBatchRun,
  listStatementBatchItems,
  listStatementBatchRuns,
  retryStatementBatchRun,
} from "@openbooks/engine/receivables/statement-batches";
import { resolveOrgEmailTransportDetailed } from "@openbooks/engine/delivery/email-config/module";
import { emailDeliveryBlockedMessage } from "@openbooks/emails";
import { ReportCurrencyBasisError } from "../reports/currency-basis";
import { buildStatementBatchPreview, type StatementBatchPreviewQuery } from "../statement-batch";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  assertTreasuryGate,
  DATE,
  IDEMPOTENCY_KEY,
  runOutsideTenantTransaction,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";

const statementBatchHref = (runId: string) =>
  `/reports/statements?run=${encodeURIComponent(runId)}`;
const statementRead = (context: ApplicationContext) => {
  assertApplicationPermission(context, "ar.read");
  assertApplicationPermission(context, "reports.read");
};
const statementWrite = (context: ApplicationContext) => {
  assertApplicationPermission(context, "ar.create");
  statementRead(context);
};
const previewSchema = z.object({
  from: DATE.nullable().optional().describe("Optional start of statement period."),
  to: DATE.nullable()
    .optional()
    .describe("Optional end of statement period; omission uses the route's native default."),
  overdueOnly: z
    .boolean()
    .optional()
    .describe("Limit recipients to customers with overdue balances."),
  subsidiaryId: UUID.nullable().optional().describe("Limit the batch to this visible subsidiary."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .nullable()
    .optional()
    .describe("Optional reporting currency."),
});

async function buildPreview(context: ApplicationContext, input: z.infer<typeof previewSchema>) {
  const query: StatementBatchPreviewQuery = {
    from: input.from ?? null,
    to: input.to ?? null,
    overdueOnly: input.overdueOnly,
    subsidiaryId: input.subsidiaryId ?? null,
    currency: input.currency ?? null,
  };
  if (
    query.subsidiaryId &&
    context.authz.allowedSubsidiaryIds &&
    !context.authz.allowedSubsidiaryIds.has(query.subsidiaryId)
  )
    throw notFound("record");
  return buildStatementBatchPreview(
    context.authz.user.orgId,
    context.authz.allowedSubsidiaryIds,
    can(context.authz, "payroll.read"),
    query,
  );
}

export const TREASURY_COLLECTION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_collections_worklist",
    title: "List Collections Worklist",
    description:
      "List overdue and near-term customer invoices with exact balances and predicted collection dates. Use returned invoice ids with payment and dunning workflows; the read applies the caller's subsidiary scope.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ar.read"),
    execute: async (context) => {
      await assertTreasuryGate(context, "ar.read");
      const [locale, config] = await Promise.all([
        getLocale(),
        analyticsConfig(context.authz.user.orgId, "cashflow"),
      ]);
      const position = await arPosition(
        context.authz.user.orgId,
        config.defaultHorizonWeeks ?? ANALYTICS_CONFIG.cashflow.defaults.defaultHorizonWeeks,
        {
          weeklyCap: normalizeMoneyValue(String(config.weeklyApCap ?? 0)),
          restrictToSafe: (config.restrictToSafe ?? 0) >= 1,
        },
        undefined,
        context.authz.allowedSubsidiaryIds,
        locale,
      );
      return {
        asOf: position.asOf,
        overdue: position.overdue,
        expectedThisWeek: position.expectedThisWeek,
        unappliedCredits: position.unappliedCredits,
        canCollect: can(context.authz, "ar.pay"),
        rows: position.worklist
          .filter((entry) => entry.docId && entry.docKind === "customer_invoice")
          .map((entry) => ({
            id: entry.id,
            docId: entry.docId,
            docKind: entry.docKind,
            docNumber: entry.docNumber,
            partyName: entry.partyName,
            amount: entry.amount,
            dueDate: entry.dueDate,
            predictedDate: entry.predictedDate,
            daysOverdue: entry.daysOverdue,
            method: entry.method,
          })),
      };
    },
  }),
  definition({
    name: "preview_statement_batch",
    title: "Preview Statement Batch",
    description:
      "Preview statement recipients, balances, and missing email addresses before sending a customer statement batch. The preview applies the caller's subsidiary scope and uses the same filters as create_statement_batch.",
    inputSchema: previewSchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ar.read") && can(authz, "reports.read"),
    execute: async (context, rawInput) => {
      const input = rawInput as z.infer<typeof previewSchema>;
      statementRead(context);
      try {
        return (await buildPreview(context, input)) as unknown as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ReportCurrencyBasisError) settleDomainRefusal(error, 422);
        throw error;
      }
    },
  }),
  definition({
    name: "list_statement_batch_runs",
    title: "List Statement Batch Runs",
    description:
      "List recent customer statement batch runs visible in your subsidiary scope. Use a returned run id with get_statement_batch_run to inspect delivery status and failures.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum number of recent runs to return; defaults to 25."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ar.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.read");
      return {
        runs: await listStatementBatchRuns(context.authz.user.orgId, {
          limit: input.limit ?? 25,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        }),
      };
    },
  }),
  definition({
    name: "get_statement_batch_run",
    title: "Get Statement Batch Run",
    description:
      "Read a statement batch's audited recipient list and delivery counts before deciding whether to retry. Use an id from list_statement_batch_runs; runs outside your subsidiary scope read as missing.",
    inputSchema: z.object({
      runId: UUID.describe("Statement batch run id from list_statement_batch_runs."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ar.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ar.read");
      const run = await getStatementBatchRun(
        context.authz.user.orgId,
        input.runId,
        context.authz.allowedSubsidiaryIds,
      );
      if (!run) throw notFound("record");
      const items = await listStatementBatchItems(
        context.authz.user.orgId,
        input.runId,
        context.authz.allowedSubsidiaryIds,
      );
      const counts = {
        queued: items.filter((item) => item.status === "queued" || item.status === "sending")
          .length,
        sent: items.filter((item) => item.status === "sent").length,
        failed: items.filter((item) => item.status === "failed").length,
        skipped: items.filter((item) => item.status === "skipped").length,
      };
      return {
        run: {
          id: run.id,
          periodFrom: run.periodFrom,
          periodTo: run.periodTo,
          filters: run.filters,
          recipientCount: run.recipientCount,
          status: run.status,
          createdAt: run.createdAt,
          createdBy: run.createdBy,
          counts,
        },
        items,
        href: statementBatchHref(input.runId),
      };
    },
  }),
  definition({
    name: "create_statement_batch",
    title: "Create Statement Batch",
    description:
      "Create a customer statement batch for the same filters shown by preview_statement_batch and enqueue one delivery per recipient. Requires ar.create, ar.read, reports.read and configured outbound email; read the run afterward to track failures.",
    inputSchema: previewSchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      can(authz, "ar.create") && can(authz, "ar.read") && can(authz, "reports.read"),
    execute: async (context, input) => {
      statementWrite(context);
      const orgId = context.authz.user.orgId;
      const delivery = await resolveOrgEmailTransportDetailed(orgId);
      if (delivery.state !== "ready") throw invalidInput(emailDeliveryBlockedMessage(delivery));
      let preview;
      try {
        preview = await buildPreview(context, input);
      } catch (error) {
        if (error instanceof ReportCurrencyBasisError) settleDomainRefusal(error, 422);
        throw error;
      }
      if (preview.recipients.length === 0)
        throw invalidInput("statement batch has no recipients — adjust the period or filters");
      try {
        const run = await runOutsideTenantTransaction(context, () =>
          createStatementBatchRun({
            orgId,
            senderId: context.authz.user.id,
            periodFrom: preview.from,
            periodTo: preview.to,
            filters: {
              ...(input.overdueOnly ? { overdueOnly: true } : {}),
              ...(input.subsidiaryId ? { subsidiaryId: input.subsidiaryId } : {}),
              ...(input.currency ? { currency: input.currency.toUpperCase() } : {}),
            },
            recipients: preview.recipients.map((recipient) => ({
              partyId: recipient.partyId,
              balance: recipient.balance,
              overdue: recipient.overdue,
              currency: recipient.currency,
              toEmail: recipient.toEmail,
            })),
            excluded: preview.excluded.map((item) => ({
              partyId: item.partyId,
              balance: item.balance,
              overdue: item.overdue,
            })),
            allowedSubsidiaryIds:
              context.authz.allowedSubsidiaryIds === null
                ? null
                : [...context.authz.allowedSubsidiaryIds].sort(),
            enqueue: (jobs) => enqueueStatementBatchJobs(jobs),
          }),
        );
        return {
          ok: true,
          runId: run.runId,
          queued: run.queued,
          skipped: run.skipped,
          status: "sending",
          href: statementBatchHref(run.runId),
        };
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  }),
  definition({
    name: "retry_statement_batch_run",
    title: "Retry Statement Batch Run",
    description:
      "Requeue failed and never-attempted customer statement deliveries; already sent customers are not sent again. Use get_statement_batch_run to review the recipients and failures before retrying.",
    inputSchema: z.object({
      runId: UUID.describe("Statement batch run id from get_statement_batch_run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      can(authz, "ar.create") && can(authz, "ar.read") && can(authz, "reports.read"),
    execute: async (context, input) => {
      statementWrite(context);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          retryStatementBatchRun(
            context.authz.user.orgId,
            input.runId,
            context.authz.user.id,
            enqueueStatementBatchJobs,
            context.authz.allowedSubsidiaryIds,
          ),
        );
        return {
          ok: true,
          runId: input.runId,
          requeued: result.requeued,
          status: "sending",
          href: statementBatchHref(input.runId),
        };
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  }),
];
