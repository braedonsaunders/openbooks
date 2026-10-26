import { apiErrorResponse } from "@/lib/api/error-response";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  BANK_STATEMENT_PARSER_VERSION,
  BankingError,
  decodeStatementSourceText,
  importStatement,
  parseBai2,
  parseCamt053,
  parseCsv,
  parseCsvRows,
  parseMt940,
  parseOfx,
  type CsvMapping,
  type ParsedStatement,
  type ParsedStatementLine,
  type SkippedStatementRow,
} from "@openbooks/engine/banking/banking";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";

export const runtime = "nodejs";

interface ImportBody {
  accountId?: string;
  source?: "ofx" | "csv" | "camt053" | "bai2" | "mt940";
  text?: string;
  /** Exact bytes from a browser file upload. Engine parsers decode these bytes directly. */
  sourceBytesBase64?: string | null;
  filename?: string | null;
  contentType?: string | null;
  mapping?: CsvMapping;
  /**
   * decode  — return engine-decoded review text for exact browser-upload bytes.
   * columns — CSV only: return header + sample rows so the client can build
   *           the column-mapping selects (single parser lives in the engine).
   * preview — parse + dedupe, write nothing.
   * import  — parse + dedupe + persist.
   */
  mode?: "decode" | "columns" | "preview" | "import";
  statementDate?: string | null;
  openingBalance?: string | null;
  closingBalance?: string | null;
  /**
   * Import lines flagged as possible duplicates of lines already on the
   * account. Default false: they are listed in the preview and left out of
   * the import until the reviewer opts in.
   */
  includePossibleDuplicates?: boolean;
}

const CANONICAL_BASE64 = /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/;

const routeBodySchema = z
  .object({
    accountId: uuidString().optional(),
    source: z.enum(["ofx", "csv", "camt053", "bai2", "mt940"]).optional(),
    text: z.string().optional(),
    sourceBytesBase64: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    contentType: z.string().nullable().optional(),
    mapping: z
      .object({
        date: z.number().int().nonnegative(),
        amount: z.number().int().nonnegative(),
        description: z.number().int().nonnegative(),
        counterpartyRef: z.number().int().nonnegative().optional(),
        bankTransactionId: z.number().int().nonnegative().optional(),
        debitAmount: z.number().int().nonnegative().optional(),
      })
      .optional(),
    mode: z
      .enum(["decode", "columns", "preview", "import"], {
        error: "mode must be decode, columns, preview or import",
      })
      .optional(),
    statementDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    openingBalance: z.string().nullable().optional(),
    closingBalance: z.string().nullable().optional(),
    includePossibleDuplicates: z.boolean().optional(),
  })
  .optional();

/** Decode browser-upload evidence without accepting Node's permissive base64 aliases. */
function uploadedSourceBytes(value: unknown): Buffer | null | "invalid" {
  if (value == null) return null;
  if (typeof value !== "string" || !CANONICAL_BASE64.test(value)) return "invalid";
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : "invalid";
}

/** Exact numeric(19,4) money string, null when omitted, or 'invalid'. */
function persistMoney(value: unknown): string | null | "invalid" {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return "invalid";
  try {
    return normalizeMoney(exact);
  } catch {
    return "invalid";
  }
}

export const POST = defineRoute({
  permission: "banking.reconcile",
  feature: "banking",
  body: routeBodySchema,
  maxBodyBytes: 10 * 1024 * 1024,
  handler: async ({ authz: routeAuthz, body: routeBody }) => {
    if (routeBody === undefined) {
      return NextResponse.json({ error: "invalid request body" }, { status: 400 });
    }
    const gate = routeAuthz;
    const { user } = gate;
    const body = routeBody as ImportBody;
    const mode = body.mode ?? "preview";
    if (mode !== "decode" && mode !== "columns" && mode !== "preview" && mode !== "import") {
      return NextResponse.json(
        { error: "mode must be decode, columns, preview or import" },
        { status: 400 },
      );
    }
    const uploadedBytes = uploadedSourceBytes(body.sourceBytesBase64);
    if (uploadedBytes === "invalid") {
      return NextResponse.json(
        { error: "Uploaded statement bytes must be canonical base64" },
        { status: 400 },
      );
    }
    const sourceContent = uploadedBytes ?? (typeof body.text === "string" ? body.text : null);
    if (
      sourceContent === null ||
      (typeof sourceContent === "string" ? !sourceContent.trim() : sourceContent.byteLength === 0)
    ) {
      return NextResponse.json({ error: "Paste or upload statement text first" }, { status: 400 });
    }
    try {
      if (mode === "decode") {
        if (
          body.source !== "ofx" &&
          body.source !== "csv" &&
          body.source !== "camt053" &&
          body.source !== "bai2" &&
          body.source !== "mt940"
        ) {
          return NextResponse.json(
            { error: "source must be ofx, csv, camt053, bai2 or mt940" },
            { status: 400 },
          );
        }
        return NextResponse.json({ text: decodeStatementSourceText(sourceContent, body.source) });
      }

      if (mode === "columns") {
        if (body.source !== "csv") {
          return NextResponse.json(
            { error: "Column detection applies to CSV only" },
            { status: 400 },
          );
        }
        const rows = parseCsvRows(sourceContent);
        return NextResponse.json({
          header: rows[0],
          sample: rows.slice(1, 6),
          rowCount: rows.length,
        });
      }

      if (!body.accountId) {
        return NextResponse.json({ error: "accountId required" }, { status: 400 });
      }

      let lines: ParsedStatementLine[];
      let skippedLines: SkippedStatementRow[] = [];
      let meta: Omit<ParsedStatement, "lines"> = {};
      if (body.source === "ofx") {
        const parsed = parseOfx(sourceContent);
        lines = parsed.lines;
        meta = {
          currency: parsed.currency,
          statementDate: parsed.statementDate,
          closingBalance: parsed.closingBalance,
        };
      } else if (body.source === "csv") {
        if (
          !body.mapping ||
          body.mapping.date == null ||
          body.mapping.amount == null ||
          body.mapping.description == null
        ) {
          return NextResponse.json(
            { error: "CSV column mapping (date, amount, description) required" },
            { status: 400 },
          );
        }
        const csvParsed = parseCsv(sourceContent, body.mapping);
        lines = csvParsed.lines;
        skippedLines = csvParsed.skipped;
      } else if (body.source === "camt053" || body.source === "bai2" || body.source === "mt940") {
        const parsed =
          body.source === "camt053"
            ? parseCamt053(sourceContent)
            : body.source === "bai2"
              ? parseBai2(sourceContent)
              : parseMt940(sourceContent);
        lines = parsed.lines;
        meta = {
          currency: parsed.currency,
          statementDate: parsed.statementDate,
          closingBalance: parsed.closingBalance,
        };
      } else {
        return NextResponse.json(
          { error: "source must be ofx, csv, camt053, bai2 or mt940" },
          { status: 400 },
        );
      }

      const openingBalance = persistMoney(body.openingBalance);
      if (openingBalance === "invalid") {
        return NextResponse.json(
          { error: moneyRefusal("Opening balance", body.openingBalance) },
          { status: 422 },
        );
      }
      const closingFromRequest = persistMoney(body.closingBalance);
      if (closingFromRequest === "invalid") {
        return NextResponse.json(
          { error: moneyRefusal("Closing balance", body.closingBalance) },
          { status: 422 },
        );
      }

      const result = await importStatement(
        {
          accountId: body.accountId,
          source: body.source,
          lines,
          skippedLines,
          statementDate: body.statementDate ?? meta.statementDate ?? null,
          openingBalance,
          closingBalance: closingFromRequest ?? meta.closingBalance ?? null,
          currency: meta.currency ?? null,
          sourceEvidence: {
            content: sourceContent,
            filename: typeof body.filename === "string" ? body.filename : null,
            ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
            parserVersion: BANK_STATEMENT_PARSER_VERSION,
            csvMapping: body.source === "csv" ? body.mapping : null,
          },
          includePossibleDuplicates: body.includePossibleDuplicates === true,
          dryRun: mode === "preview",
        },
        {
          orgId: user.orgId,
          userId: user.id,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        },
      );

      if (mode === "import" && result.statementId === null) {
        if (result.possibleDuplicates > 0 && body.includePossibleDuplicates !== true) {
          throw new BankingError(
            `Nothing imported — ${result.possibleDuplicates} line${result.possibleDuplicates === 1 ? "" : "s"} match${result.possibleDuplicates === 1 ? "es" : ""} a line already on this account and ${result.possibleDuplicates === 1 ? "was" : "were"} excluded as possible duplicate${result.possibleDuplicates === 1 ? "" : "s"}; review them in the preview and import them anyway to include them`,
          );
        }
        if (result.balanceCandidates.length > 0 && result.duplicates === 0) {
          throw new BankingError(
            `Nothing imported — ${result.balanceCandidates.length} row${result.balanceCandidates.length === 1 ? "" : "s"} look${result.balanceCandidates.length === 1 ? "s" : ""} like a statement balance, not a transaction; use ${result.balanceCandidates.length === 1 ? "it" : "them"} as the opening or closing balance instead`,
          );
        }
        throw new BankingError(
          `Nothing imported — all ${result.duplicates} line${result.duplicates === 1 ? "" : "s"} were already on this account`,
        );
      }

      return NextResponse.json({
        statementId: result.statementId,
        sourceEvidenceRef: result.sourceEvidenceRef,
        imported: result.imported,
        duplicates: result.duplicates,
        possibleDuplicates: result.possibleDuplicates,
        possibleDuplicateLines: mode === "preview" ? result.possibleDuplicateLines : undefined,
        skipped: result.skipped,
        balanceCandidates: result.balanceCandidates,
        suggestedOpening: result.suggestedOpening,
        openingMismatch: result.openingMismatch,
        statementLinesTotal: result.statementLinesTotal,
        balanceMismatch: result.balanceMismatch,
        statementDate: meta.statementDate ?? null,
        closingBalance: meta.closingBalance ?? null,
        currency: meta.currency ?? null,
        lines: mode === "preview" ? result.lines : undefined,
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
