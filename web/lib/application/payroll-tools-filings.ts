import "server-only";
import { z } from "zod";
import {
  assertPayrollActor,
  IDEMPOTENCY_KEY,
  payrollActor,
  settlePayrollRefusal,
} from "./payroll-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { recordPayrollFilingIssue } from "../payroll/filing-issue";
import { FilingScopeDenied } from "../payroll/filing-issue";
import { ApplicationError, notFound } from "./errors";

const YEAR = z
  .number()
  .int()
  .min(2000)
  .max(2100)
  .describe("Tax year copied from payroll_year_end.");
const PACK_COUNTRY = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .describe(
    "Country/jurisdiction code shown on the pack-declared payroll_year_end section; pass it through without interpreting it.",
  );
const FILING_KEY = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Filing key from the selected payroll_year_end section.");
const PARAMETERS = z
  .record(
    z.string().min(1).max(64).describe("Pack-declared filing parameter name."),
    z.string().max(610000).describe("Text value required by the selected pack filing."),
  )
  .refine(
    (input) =>
      Object.keys(input).length <= 8 &&
      Object.values(input).reduce((total, value) => total + value.length, 0) <= 610000,
  )
  .optional()
  .describe("Pack-owned selection parameters for filings that issue selected rows.");
const ROW_IDS = z
  .array(z.string().min(1).describe("Filing row id from payroll_year_end."))
  .min(1)
  .max(1000)
  .describe("Exact filing rows to amend or cancel.");

function filingHref(country: string, filing: string, year: number) {
  return `/payroll/year-end?country=${encodeURIComponent(country)}&filing=${encodeURIComponent(filing)}&year=${year}`;
}

async function issue(
  context: Parameters<typeof assertPayrollActor>[0],
  input: {
    country: string;
    filing: string;
    year: number;
    revision: "original" | "amended" | "cancelled";
    params?: Record<string, string>;
    rowIds?: string[];
    note?: string;
    reason?: string;
  },
) {
  await assertPayrollActor(context, "payroll.run");
  try {
    const result = await recordPayrollFilingIssue(context.authz, input);
    return {
      ok: true,
      submission: {
        id: result.submission.id,
        revision: result.submission.revision,
        revisionNumber: result.submission.revisionNumber,
        issuedAt: result.submission.issuedAt,
        slipCount: result.submission.slipCount,
        artifact: result.submission.artifact,
      },
      fileRefusal: result.fileRefusal,
      href: filingHref(input.country, input.filing, input.year),
    };
  } catch (error) {
    if (error instanceof FilingScopeDenied) {
      if (error.response.status === 404) throw notFound("record");
      const refusal = (await error.response.json().catch(() => ({}))) as { error?: unknown };
      throw new ApplicationError(
        "forbidden",
        typeof refusal.error === "string"
          ? refusal.error
          : "Payroll filing is outside the caller's authorized scope.",
        error.response.status,
      );
    }
    settlePayrollRefusal(error);
  }
}

export const PAYROLL_FILING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "record_payroll_filing_issue",
    title: "Record Payroll Filing Issue",
    description:
      "Record an original or amended filing issue using the filing pack's selected population, row grammar and artifact builder. Find the jurisdiction, filing key, year and row ids with payroll_year_end; verify the new issue in payroll year-end history.",
    inputSchema: z
      .object({
        revision: z
          .enum(["original", "amended"])
          .describe("Choose the original issue or an amendment to filed rows."),
        country: PACK_COUNTRY,
        filing: FILING_KEY,
        year: YEAR,
        params: PARAMETERS,
        confirmedAmendment: z
          .literal(true)
          .optional()
          .describe("Confirm that the selected rows are being amended."),
        rowIds: ROW_IDS.optional(),
        note: z
          .string()
          .trim()
          .max(2000)
          .optional()
          .describe("Issue note or amendment reason retained in filing history."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, context) => {
        if (input.revision === "amended") {
          if (input.confirmedAmendment !== true)
            context.addIssue({
              code: "custom",
              path: ["confirmedAmendment"],
              message: "Confirm that the selected rows are being amended.",
            });
          if (!input.rowIds)
            context.addIssue({
              code: "custom",
              path: ["rowIds"],
              message: "Choose exact filed rows to amend.",
            });
          if (input.params !== undefined)
            context.addIssue({
              code: "custom",
              path: ["params"],
              message: "Pack selection parameters apply only to the original issue.",
            });
        } else if (input.confirmedAmendment !== undefined || input.rowIds !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["revision"],
            message: "Original issues do not accept amendment row selections.",
          });
        }
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) =>
      input.revision === "original"
        ? issue(context, {
            country: input.country,
            filing: input.filing,
            year: input.year,
            revision: "original",
            params: input.params,
            note: input.note,
          })
        : issue(context, {
            country: input.country,
            filing: input.filing,
            year: input.year,
            revision: "amended",
            rowIds: input.rowIds!,
            note: input.note,
          }),
  }),
  definition({
    name: "cancel_payroll_filing",
    title: "Cancel Payroll Filing",
    description:
      "Record a cancellation for previously issued filing rows with an explicit reason. Find the filing jurisdiction, key, year and exact row ids with payroll_year_end; verify the cancellation in filing history.",
    inputSchema: z.object({
      country: PACK_COUNTRY,
      filing: FILING_KEY,
      year: YEAR,
      confirmedCancellation: z
        .literal(true)
        .describe("Confirm this statutory filing cancellation."),
      rowIds: ROW_IDS,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for cancelling the filed rows; retained as audit evidence."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: payrollActor("payroll.run"),
    featureKey: "payroll",
    execute: async (context, input) => issue(context, { ...input, revision: "cancelled" }),
  }),
];
