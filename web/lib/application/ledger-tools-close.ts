import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assignGlAuditNumbers,
  GlAuditNumberError,
} from "@openbooks/engine/close/gl-audit-numbering";
import { addCloseEvidence } from "@openbooks/engine/close/tasks";
import {
  commitPostingPeriodAssignment,
  PostingPeriodAssignmentError,
  previewPostingPeriodAssignment,
} from "@openbooks/engine/close/posting-periods";
import {
  generatePeriodEndJournals,
  periodEndJournalHistory,
  PeriodEndJournalError,
  previewPeriodEndJournals,
  reversePeriodEndJournals,
} from "@openbooks/engine/close/period-end-journals";
import { runScheduledJournalReversals } from "@openbooks/engine/ledger/journal-reversals";
import {
  runUnbilledRevenueAccrual,
  UnbilledAccrualError,
} from "@openbooks/engine/projects/unbilled-accrual";
import {
  applyHistoricalTranslationContribution,
  HistoricalTranslationEvidenceError,
  proposeHistoricalTranslationContribution,
  readHistoricalTranslationAuthoringContext,
} from "@openbooks/engine/journal/historical-translation-evidence";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { CloseError } from "@openbooks/engine/periods/period-policy";
import { can } from "../authz";
import { guardCloseScope } from "../close-scope";
import { historicalTranslationProposalBody } from "../api/historical-translation-schema";
import {
  listApplicationRevaluationExposures,
  recordApplicationClosingFxRateEvidence,
} from "./close";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by a native ledger or close read.");
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
  if (error instanceof HistoricalTranslationEvidenceError) {
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  if (error instanceof ScopeNotFoundError) throw notFound("historical translation assessment");
  if (error instanceof PeriodEndJournalError) {
    const details = {
      code: error.code,
      ...(error.remedy ? { remedy: error.remedy } : {}),
      ...(error.details ?? {}),
    };
    if (error.code === "forbidden")
      throw new ApplicationError("forbidden", error.message, 403, details);
    throw new ApplicationError("invalid_input", error.message, 422, details);
  }
  if (
    error instanceof CloseError ||
    error instanceof PostingError ||
    error instanceof PostingPeriodAssignmentError
  ) {
    const details =
      error instanceof PostingError && typeof error.details === "object" && error.details !== null
        ? (error.details as Record<string, unknown>)
        : undefined;
    throw new ApplicationError("invalid_input", error.message, 422, details);
  }
  if (error instanceof Error) {
    const refusal = error as Error & {
      status?: unknown;
      code?: unknown;
      remedy?: unknown;
      details?: unknown;
    };
    if (typeof refusal.status === "number") {
      const details = {
        ...(typeof refusal.details === "object" && refusal.details !== null
          ? (refusal.details as Record<string, unknown>)
          : {}),
        ...(typeof refusal.code === "string" ? { code: refusal.code } : {}),
        ...(typeof refusal.remedy === "string" ? { remedy: refusal.remedy } : {}),
      };
      if (refusal.status === 403)
        throw new ApplicationError("forbidden", refusal.message, 403, details);
      if (refusal.status === 404)
        throw new ApplicationError("not_found", refusal.message, 404, details);
      if (refusal.status === 409) throw conflict(refusal.message, details);
      if (refusal.status === 400)
        throw new ApplicationError("invalid_input", refusal.message, 400, details);
      throw invalidInput(refusal.message, details);
    }
  }
  throw error;
}

function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function evidenceRequestId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function periodEndSubsidiaries(context: ApplicationContext): string[] | null {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed !== null && allowed.size === 0) {
    throw forbidden("The caller has no legal entities in close scope.");
  }
  return allowed === null ? null : [...allowed];
}

export const LEDGER_CLOSE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "preview_period_end_journals",
    title: "Preview Period End Journals",
    description:
      "Preview the year end closing and opening journals and review their generation history before running them. Use period ids from the accounting period reads and a book id from the accounting books setup.",
    inputSchema: z.object({
      periodId: UUID.describe("A period id in the fiscal year being closed."),
      bookId: UUID.optional().describe(
        "Optional accounting book id; omitted uses the native default.",
      ),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("close.read"),
    featureKey: "periodEndJournals",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.read");
      const subsidiaryIds = periodEndSubsidiaries(context);
      try {
        const preview = await previewPeriodEndJournals(context.authz.user.orgId, {
          periodId: input.periodId,
          bookId: input.bookId,
          subsidiaryIds,
        });
        const history = await periodEndJournalHistory(context.authz.user.orgId, {
          fiscalYear: preview.fiscalYear.fiscalYear,
          bookId: preview.book.id,
          subsidiaryIds,
        });
        return { ok: true, preview, history, href: "/close" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "run_period_end_journals",
    title: "Run Period End Journals",
    description:
      "Generate the fiscal year's governed closing and opening journals, or reverse its live generation while the periods remain open. Preview first with preview_period_end_journals; the period must be at the configured year end and the reason is recorded.",
    inputSchema: z.object({
      action: z
        .enum(["generate", "reverse"])
        .describe("Generate a new close or reverse the live generation."),
      periodId: UUID.describe("Closing period id from preview_period_end_journals."),
      bookId: UUID.optional().describe(
        "Optional accounting book id; omitted uses the native default.",
      ),
      reason: z
        .string()
        .trim()
        .min(10)
        .max(500)
        .describe("Audit reason for generating or reversing."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "periodEndJournals",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      const subsidiaryIds = periodEndSubsidiaries(context);
      try {
        const args = {
          periodId: input.periodId,
          bookId: input.bookId,
          reason: input.reason,
          subsidiaryIds,
        };
        const result =
          input.action === "generate"
            ? await generatePeriodEndJournals(context.authz.user.orgId, context.authz.user.id, args)
            : await reversePeriodEndJournals(context.authz.user.orgId, context.authz.user.id, args);
        return {
          ok: true,
          ...result,
          status: input.action === "generate" ? "generated" : "reversed",
          href: "/close",
        };
      } catch (error) {
        if (error instanceof PeriodEndJournalError || error instanceof PostingError)
          settleRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "run_unbilled_revenue_accrual",
    title: "Run Unbilled Revenue Accrual",
    description:
      "Post the outstanding period end accrual for eligible unbilled project work together with its next period reversal. Supply one period id or end date; the command requires unrestricted legal entity access and the configured accrual account.",
    inputSchema: z
      .object({
        periodId: UUID.optional().describe("Accounting period id; supply this or periodEnd."),
        periodEnd: DATE.optional().describe("Period end date; supply this or periodId."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, ctx) => {
        if ((input.periodId === undefined) === (input.periodEnd === undefined)) {
          ctx.addIssue({
            code: "custom",
            path: ["periodId"],
            message: "Supply exactly one of periodId or periodEnd.",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("gl.post"),
    featureKey: "unbilledRevenueAccrual",
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      assertUnrestricted(context);
      try {
        const periodRef = input.periodId
          ? { periodId: input.periodId }
          : { periodEnd: input.periodEnd! };
        const result = await runUnbilledRevenueAccrual(
          context.authz.user.orgId,
          context.authz.user.id,
          periodRef,
        );
        return { ok: true, ...result, status: "posted", href: "/close" };
      } catch (error) {
        if (error instanceof UnbilledAccrualError || error instanceof PostingError)
          settleRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "assign_gl_audit_numbers",
    title: "Assign GL Audit Numbers",
    description:
      "Allocate audit numbers to eligible posted ledger entries for one period, accounting book, and legal entity. Use the period list and account register to find ids; the entity's GL period must be closed and the numbering policy configured.",
    inputSchema: z.object({
      periodId: UUID.describe("Accounting period id."),
      bookId: UUID.describe("Accounting book id."),
      subsidiaryId: UUID.describe("Legal entity id in the caller's allowed scope."),
      reason: z.string().trim().min(5).max(2000).describe("Audit reason for the numbering run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const { idempotencyKey: _key, ...args } = input;
        const result = await assignGlAuditNumbers({
          ...args,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, status: "assigned", href: "/close" };
      } catch (error) {
        if (error instanceof GlAuditNumberError) settleRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "preview_posting_period_assignment",
    title: "Preview Posting Period Assignment",
    description:
      "Preview which approved documents can receive a posting period for one accounting book. Use find_documents to identify document ids; the preview respects your legal entity scope and identifies rows that need an adjustment period.",
    inputSchema: z.object({
      bookId: UUID.describe("Accounting book id."),
      documentIds: z
        .array(UUID)
        .max(1000)
        .optional()
        .describe("Optional selected documents; omitted previews all eligible records."),
      adjustmentPeriodId: UUID.optional().describe(
        "Optional adjustment period for otherwise unassigned documents.",
      ),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("close.run"),
    featureKey: "continuousClose",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      const allowed = context.authz.allowedSubsidiaryIds;
      if (allowed !== null && allowed.size === 0) throw forbidden("subsidiary.scope");
      try {
        const result = await previewPostingPeriodAssignment(context.authz.user.orgId, {
          bookId: input.bookId,
          documentIds: input.documentIds,
          subsidiaryIds: allowed === null ? null : [...allowed],
          adjustmentPeriodId: input.adjustmentPeriodId,
        });
        return { ok: true, ...result, href: "/close" };
      } catch (error) {
        if (error instanceof PostingPeriodAssignmentError) settleRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "assign_posting_periods",
    title: "Assign Posting Periods",
    description:
      "Commit the posting period assignments from a reviewed preview for one accounting book. Use preview_posting_period_assignment first and pass the same selected document ids and adjustment period; rows that changed concurrently are reported as skipped.",
    inputSchema: z.object({
      bookId: UUID.describe("Accounting book id from the preview."),
      documentIds: z
        .array(UUID)
        .max(1000)
        .optional()
        .describe("The selected document ids from the preview."),
      adjustmentPeriodId: UUID.optional().describe(
        "The adjustment period from the preview, if used.",
      ),
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
      const allowed = context.authz.allowedSubsidiaryIds;
      if (allowed !== null && allowed.size === 0) throw forbidden("subsidiary.scope");
      try {
        const result = await commitPostingPeriodAssignment(context.authz.user.orgId, {
          bookId: input.bookId,
          documentIds: input.documentIds,
          subsidiaryIds: allowed === null ? null : [...allowed],
          adjustmentPeriodId: input.adjustmentPeriodId,
          actorId: context.authz.user.id,
        });
        return { ok: true, ...result, status: "assigned", href: "/close" };
      } catch (error) {
        if (error instanceof PostingPeriodAssignmentError) settleRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "list_revaluation_rate_exposures",
    title: "List Revaluation Rate Exposures",
    description:
      "List the exact foreign currency positions for which closing rate evidence can be recorded. Supply the close period and book ids; use returned exposure fields with record_revaluation_rate_evidence.",
    inputSchema: z.object({
      periodId: UUID.describe("Close period id."),
      bookId: UUID.describe("Accounting book id."),
      subsidiaryIds: z
        .array(UUID)
        .min(1)
        .max(1000)
        .optional()
        .describe("Optional selected legal entities within your scope."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiCurrency",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      const exposures = await listApplicationRevaluationExposures(context, input);
      return { ok: true, exposures, href: "/close" };
    },
  }),
  definition({
    name: "record_revaluation_rate_evidence",
    title: "Record Revaluation Rate Evidence",
    description:
      "Record an effective closing rate for one exposure returned by list_revaluation_rate_exposures. The expected current evidence id fences concurrent edits; provide the rate as an exact decimal string and a source and reason.",
    inputSchema: z.object({
      bookId: UUID.describe("Accounting book id from the exposure."),
      subsidiaryId: UUID.describe("Legal entity id from the exposure."),
      periodId: UUID.describe("Close period id from the exposure."),
      accountId: UUID.describe("Account id from the exposure."),
      transactionCurrency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Exposure transaction currency code."),
      measurementCurrency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Exposure measurement currency code."),
      rateDate: DATE.optional().describe("Rate effective date (YYYY-MM-DD)."),
      rate: z
        .string()
        .regex(/^\d{1,9}(?:\.\d{1,10})?$/)
        .describe("Positive exact exchange rate as a decimal string."),
      source: z.string().min(1).max(120).describe("Rate source recorded for audit."),
      reason: z.string().trim().min(8).max(500).describe("Reason for recording this closing rate."),
      expectedCurrentId: UUID.nullable().describe(
        "Current evidence id from the exposure, or null when none exists.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiCurrency",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      const { idempotencyKey, ...evidence } = input;
      const result = await recordApplicationClosingFxRateEvidence(context, {
        ...evidence,
        idempotencyKey: evidenceRequestId(idempotencyKey),
      });
      return { ok: true, evidence: result.result, status: "recorded", href: "/close" };
    },
  }),
  definition({
    name: "add_close_task_evidence",
    title: "Add Close Task Evidence",
    description:
      "Attach a file, report, journal, reconciliation, link or note to a manual task in an editable close run. Find the run and task ids with get_close_run_status; the caller must have unrestricted legal entity access.",
    inputSchema: z.object({
      runId: UUID.describe("Close run id from get_close_run_status."),
      taskId: UUID.describe("Task id from get_close_run_status."),
      evidenceType: z
        .enum(["file", "report", "journal", "reconciliation", "link", "note"])
        .describe("Evidence kind."),
      label: z.string().trim().min(1).max(200).describe("Short label shown in the close binder."),
      fileId: UUID.optional().describe("File id when evidenceType is file."),
      referenceId: UUID.optional().describe("Native record id when linking a ledger record."),
      referenceUrl: z
        .string()
        .max(2048)
        .regex(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^ ]+$/)
        .optional()
        .describe("URL for external evidence."),
      snapshot: z
        .record(z.string().max(100), z.json())
        .optional()
        .describe("Optional immutable evidence snapshot."),
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
      const scopeDenied = guardCloseScope(context.authz);
      if (scopeDenied) throw notFound("close evidence");
      const { idempotencyKey: _key, ...evidence } = input;
      try {
        const evidenceId = await addCloseEvidence({
          ...evidence,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
        });
        return { ok: true, evidenceId, status: "recorded", href: `/close/runs/${input.runId}` };
      } catch (error) {
        if (error instanceof CloseError) settleRefusal(error);
        throw error;
      }
    },
  }),
  definition({
    name: "run_due_journal_reversals",
    title: "Run Due Journal Reversals",
    description:
      "Process scheduled journal reversals due on or before a date. Use find_journal_entries to locate scheduled journals; the native runner records each reversal and safely skips work already completed.",
    inputSchema: z.object({
      asOf: DATE.optional().describe(
        "Process reversals due by this date; omitted uses the service business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("gl.post"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "gl.post");
      try {
        const result = await runScheduledJournalReversals({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          asOf: input.asOf,
        });
        return { ok: true, ...result, status: "processed", href: "/journals" };
      } catch (error) {
        if (
          error instanceof PostingError ||
          (error instanceof Error &&
            typeof (error as Error & { status?: unknown }).status === "number")
        ) {
          settleRefusal(error);
        }
        throw error;
      }
    },
  }),
  definition({
    name: "get_historical_translation_context",
    title: "Get Historical Translation Context",
    description:
      "Read the source journal line's retained historical evidence and approved contribution basis before proposing a translation assessment. Find source line ids with get_journal_entry.",
    inputSchema: z.object({
      sourceLineId: UUID.describe("Source journal line id from get_journal_entry."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiCurrency",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const result = await readHistoricalTranslationAuthoringContext({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          sourceLineId: input.sourceLineId,
        });
        return { ok: true, ...result, href: "/close" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_historical_translation_contribution",
    title: "Propose Historical Translation Contribution",
    description:
      "Create an approval proposal for historical translation layers on a source journal line. Use get_historical_translation_context and retained Cabinet file versions; the source currency, exact amounts, rate dates and reason must match the evidence.",
    inputSchema: z
      .object({
        instruction: z
          .object({
            sourceLineId: UUID.describe("Source journal line id."),
            measurementCurrency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .describe("Measurement currency code."),
            presentationCurrency: z
              .string()
              .regex(/^[A-Z]{3}$/)
              .describe("Presentation currency code."),
            kind: z
              .enum(["contribution", "opening", "correction"])
              .describe("Historical layer category."),
            layers: z
              .array(
                z
                  .object({
                    amount: z
                      .string()
                      .regex(/^-?\d+(?:\.\d{1,4})?$/)
                      .describe("Exact source amount as a decimal string."),
                    rate: z
                      .string()
                      .regex(/^\d{1,9}(?:\.\d{1,10})?$/)
                      .describe("Exact historical rate as a decimal string."),
                    historicalDate: DATE.describe("Historical rate date (YYYY-MM-DD)."),
                    provenance: z
                      .string()
                      .trim()
                      .min(8)
                      .max(2000)
                      .describe("Documentary explanation for the layer."),
                    source: z
                      .object({
                        fileId: UUID.describe("Cabinet file id."),
                        versionId: UUID.describe("Retained Cabinet file version id."),
                        contentHash: z
                          .string()
                          .regex(/^[a-f0-9]{64}$/)
                          .describe("SHA-256 content hash for the retained version."),
                      })
                      .describe("Retained Cabinet evidence identity."),
                    originalLayerId: UUID.nullable().describe(
                      "Original layer id for a correction, otherwise null.",
                    ),
                  })
                  .strict(),
              )
              .min(1)
              .max(200)
              .describe("Historical translation layers and their retained evidence."),
          })
          .strict()
          .describe("Translation instruction bound to the posted source line."),
        reason: z
          .string()
          .trim()
          .min(8)
          .max(1000)
          .describe("Reason recorded with the approval proposal."),
        idempotencyKey: z
          .string()
          .min(8)
          .max(120)
          .describe("Unique retry key for this exact proposal."),
      })
      .strict(),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiCurrency",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const body = historicalTranslationProposalBody.parse(input);
        const result = await proposeHistoricalTranslationContribution({
          ...body,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
        });
        return { ok: true, ...result, status: "pending_approval", href: "/close" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "apply_historical_translation_contribution",
    title: "Apply Historical Translation Contribution",
    description:
      "Apply an approved historical translation contribution proposal, preserving its evidence as an immutable basis. Find the change id through the close approval or financial change reads; the proposal must have a current approval decision.",
    inputSchema: z.object({
      changeId: UUID.describe("Approved financial change id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiCurrency",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const result = await applyHistoricalTranslationContribution({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          changeId: input.changeId,
        });
        return { ok: true, ...result, status: "applied", href: "/close" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
];
