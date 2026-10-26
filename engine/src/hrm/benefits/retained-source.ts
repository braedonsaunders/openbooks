import { createHash } from "node:crypto";
import { BenefitsError } from "./errors.ts";
import { canonicalJson } from "../../platform/canonical-json.ts";
import { parseExactJson } from "../../platform/exact-json.ts";
import { isIsoCalendarDate } from "../../platform/civil-date.ts";

export interface RetainedSourceFieldPointers {
  readonly sourceRowRefPointer?: string;
  readonly amountPointer?: string;
  readonly currencyPointer?: string;
  readonly periodFromPointer?: string;
  readonly periodToPointer?: string;
  readonly sourceIssueDatePointer?: string;
  /** Selected only by classes that must prove the source paid date from retained bytes. */
  readonly sourcePaidDatePointer?: string;
}

export type RetainedSourceClaimName = keyof RetainedSourceClaims;
export interface RetainedPdfFieldSelection {
  /** Exact quotation containing the selected value on this page. */
  readonly quote: string;
  readonly value: string;
  readonly format:
    "text" | "decimal" | "grouped-decimal" | "iso-date" | "us-date" | "iso-timestamp-date";
}
export interface RetainedPdfSelection {
  readonly page: number;
  /** The reviewed recipient or record context, retained independently of field quotations. */
  readonly anchor: string;
  readonly fields: Readonly<Partial<Record<RetainedSourceClaimName, RetainedPdfFieldSelection>>>;
}

export interface RetainedSourceArtifactSelection {
  readonly fileId: string;
  readonly versionId: string;
  readonly rowPointer: string;
  readonly sourceFields?: RetainedSourceFieldPointers;
  readonly pdfSelection?: RetainedPdfSelection;
}

export interface VerifiedRetainedSourceArtifact extends RetainedSourceArtifactSelection {
  readonly filename: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly bytesBase64: string;
  readonly rowSha256: string;
  readonly row: Record<string, unknown>;
}

export interface RetainedSourceClaims {
  readonly sourceRowRef: string;
  readonly value: string;
  readonly currency: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly sourceIssueDate: string;
  readonly sourcePaidDate?: string;
}

export interface ParsedRetainedSourceRow {
  readonly row: Record<string, unknown>;
  readonly rowSha256: string;
  readonly claims?: Partial<RetainedSourceClaims>;
}
type MutableRetainedClaims = { -readonly [K in keyof RetainedSourceClaims]?: string };

/** Canonical JSON for retained row membership proofs. */
export function canonicalRetainedJson(value: unknown): string {
  return canonicalJson(value);
}

/** Bind a source-first confirmation to its exact period, cutoff and native facts. */
export function sourceEvidenceNativePreviewDigest(input: {
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly asOf: string;
  readonly nativeSnapshot: Record<string, unknown>;
}): string {
  return createHash("sha256").update(canonicalRetainedJson(input), "utf8").digest("hex");
}

/** A bounded JSON Pointer resolver shared by the route and engine command. */
export function resolveRetainedJsonPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/") || pointer.length > 1024) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "retained source fields use a bounded JSON Pointer path",
    );
  }
  let current = document;
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(raw))
      throw new BenefitsError(
        "INVALID_INPUT",
        "retained source pointer contains an invalid escape",
      );
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current) && /^(0|[1-9][0-9]*)$/.test(part)) current = current[Number(part)];
    else if (current !== null && typeof current === "object" && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new BenefitsError(
        "REFUSED",
        "the selected retained source field does not exist in this file version",
      );
    }
  }
  return current;
}

/** Parse exact retained bytes. Invalid UTF-8 is refused instead of repaired. */
export function parseRetainedJsonBytes(bytes: Uint8Array): unknown {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseExactJson(decoded, { rejectDuplicateKeys: true });
  } catch {
    throw new BenefitsError(
      "REFUSED",
      "source evidence must be valid UTF-8 JSON with unique object keys from the retained file version",
    );
  }
}

function exactText(row: Record<string, unknown>, pointer: string, label: string): string {
  const value = resolveRetainedJsonPointer(row, pointer);
  if (typeof value !== "string" || value.trim() === "") {
    throw new BenefitsError(
      "REFUSED",
      `retained ${label} must be exact text in the selected source row`,
    );
  }
  return value.trim();
}

function exactReference(row: Record<string, unknown>, pointer: string): string {
  const value = resolveRetainedJsonPointer(row, pointer);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new BenefitsError(
    "REFUSED",
    "retained source-row reference must be exact text or a safe integer identifier",
  );
}

/** Resolve a selected row and its explicit source-field map from retained bytes. */
export function parseRetainedSourceRow(
  bytes: Uint8Array,
  rowPointer: string,
  fields?: RetainedSourceFieldPointers,
): ParsedRetainedSourceRow {
  const document = parseRetainedJsonBytes(bytes);
  const selected = resolveRetainedJsonPointer(document, rowPointer);
  if (selected === null || typeof selected !== "object" || Array.isArray(selected)) {
    throw new BenefitsError(
      "REFUSED",
      "the selected retained source field must identify one row object",
    );
  }
  const row = selected as Record<string, unknown>;
  const rowSha256 = createHash("sha256").update(canonicalRetainedJson(row), "utf8").digest("hex");
  if (!fields) return { row, rowSha256 };
  const claims: MutableRetainedClaims = {};
  const mappings = {
    sourceRowRef: fields.sourceRowRefPointer,
    value: fields.amountPointer,
    currency: fields.currencyPointer,
    periodFrom: fields.periodFromPointer,
    periodTo: fields.periodToPointer,
    sourceIssueDate: fields.sourceIssueDatePointer,
    sourcePaidDate: fields.sourcePaidDatePointer,
  } as const;
  for (const [key, pointer] of Object.entries(mappings)) {
    if (pointer === undefined) continue;
    claims[key as RetainedSourceClaimName] =
      key === "sourceRowRef" ? exactReference(row, pointer) : exactText(row, pointer, key);
  }
  if (claims.currency !== undefined) {
    claims.currency = claims.currency.toUpperCase();
    if (!/^[A-Z]{3}$/.test(claims.currency))
      throw new BenefitsError("REFUSED", "selected retained row has no exact currency code");
  }
  return { row, rowSha256, claims };
}

function normalizedPdfText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function requireUniqueQuote(page: string, quote: string): string {
  const text = normalizedPdfText(quote);
  if (
    !text ||
    text.length > 4000 ||
    page.indexOf(text) < 0 ||
    page.indexOf(text, page.indexOf(text) + 1) >= 0
  ) {
    throw new BenefitsError(
      "REFUSED",
      "select an exact quotation that occurs once on the retained PDF page",
    );
  }
  return text;
}

/** Pure, deterministic selection over native extracted page text. It accepts
 * only literal values inside verified quotations, never regexes or inferred facts. */
export function parseRetainedPdfPage(
  pageText: string,
  selection: RetainedPdfSelection,
): ParsedRetainedSourceRow {
  if (!Number.isSafeInteger(selection.page) || selection.page < 1 || selection.page > 2000) {
    throw new BenefitsError("INVALID_INPUT", "select a supported positive PDF page number");
  }
  const page = normalizedPdfText(pageText);
  const anchor = requireUniqueQuote(page, selection.anchor);
  const claims: MutableRetainedClaims = {};
  const bindings: Record<string, unknown> = {};
  const names: RetainedSourceClaimName[] = [
    "sourceRowRef",
    "value",
    "currency",
    "periodFrom",
    "periodTo",
    "sourceIssueDate",
    "sourcePaidDate",
  ];
  if (
    !selection.fields ||
    Object.keys(selection.fields).some((key) => !names.includes(key as RetainedSourceClaimName))
  ) {
    throw new BenefitsError("INVALID_INPUT", "PDF evidence selects only supported source facts");
  }
  for (const [key, field] of Object.entries(selection.fields)) {
    if (!field || typeof field.quote !== "string" || typeof field.value !== "string")
      throw new BenefitsError("INVALID_INPUT", "PDF fields require a literal quote and value");
    const quote = requireUniqueQuote(page, field.quote);
    const literal = normalizedPdfText(field.value);
    if (!literal || literal.length > 300 || !quote.includes(literal))
      throw new BenefitsError(
        "REFUSED",
        "the selected source value is absent from its retained PDF quotation",
      );
    let value = literal;
    if (field.format === "grouped-decimal") {
      if (!/^-?(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d{1,4})?$/.test(value))
        throw new BenefitsError("REFUSED", "the PDF amount has no exact supported grouping");
      value = value.replace(/,/g, "");
    } else if (field.format === "decimal") {
      if (!/^-?\d+(?:\.\d{1,4})?$/.test(value))
        throw new BenefitsError("REFUSED", "the PDF amount is not exact decimal text");
    } else if (field.format === "us-date") {
      const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
      if (!parts)
        throw new BenefitsError(
          "REFUSED",
          "the selected PDF date is not in its declared MM/DD/YYYY format",
        );
      value = `${parts[3]}-${parts[1]}-${parts[2]}`;
    } else if (field.format === "iso-timestamp-date") {
      if (!/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value))
        throw new BenefitsError(
          "REFUSED",
          "the PDF report timestamp is not in its declared format",
        );
      value = value.slice(0, 10);
    } else if (field.format !== "text" && field.format !== "iso-date") {
      throw new BenefitsError("INVALID_INPUT", "select a supported explicit PDF value format");
    }
    if (
      ["periodFrom", "periodTo", "sourceIssueDate", "sourcePaidDate"].includes(key) &&
      !isIsoCalendarDate(value)
    ) {
      throw new BenefitsError("REFUSED", "the selected PDF date is not a valid civil date");
    }
    if (key === "currency" && !/^[A-Z]{3}$/.test(value))
      throw new BenefitsError("REFUSED", "PDF currency evidence must state an exact currency code");
    claims[key as RetainedSourceClaimName] = value;
    bindings[key] = { quote, literal, format: field.format, value };
  }
  const printedCurrencyCodes = [
    ...new Set(
      [...page.matchAll(/\b(?:currency|ccy)\s*[:=]?\s*([A-Z]{3})\b/gi)].map((match) =>
        match[1]!.toUpperCase(),
      ),
    ),
  ];
  const row = {
    kind: "retained-pdf-text-selection",
    page: selection.page,
    anchor,
    bindings,
    printedCurrencyCodes,
    pageTextSha256: createHash("sha256").update(pageText, "utf8").digest("hex"),
  };
  return {
    row,
    rowSha256: createHash("sha256").update(canonicalRetainedJson(row), "utf8").digest("hex"),
    claims,
  };
}

/** The same format boundary is used by advisory preview and authoritative recording. */
export async function parseRetainedSourceArtifact(
  bytes: Uint8Array,
  contentType: string,
  selection: RetainedSourceArtifactSelection,
): Promise<ParsedRetainedSourceRow> {
  if (selection.pdfSelection) {
    if (
      contentType.split(";")[0]?.trim().toLowerCase() !== "application/pdf" ||
      selection.sourceFields ||
      selection.rowPointer !== ""
    ) {
      throw new BenefitsError(
        "INVALID_INPUT",
        "PDF page selection cannot be combined with JSON row fields",
      );
    }
    try {
      const { extractPdfPageText } = await import("@openbooks/pdf/text");
      return parseRetainedPdfPage(
        await extractPdfPageText(bytes, selection.pdfSelection.page),
        selection.pdfSelection,
      );
    } catch (error) {
      if (error instanceof BenefitsError) throw error;
      const refusal = new BenefitsError("REFUSED", (error as Error).message);
      refusal.cause = error;
      throw refusal;
    }
  }
  if (contentType.split(";")[0]?.trim().toLowerCase() === "application/pdf")
    throw new BenefitsError("INVALID_INPUT", "select a PDF page and its literal source quotations");
  return parseRetainedSourceRow(bytes, selection.rowPointer, selection.sourceFields);
}

/** Corroborating facts may supplement a source row, but never override it. */
export function combineRetainedSourceClaims(
  rows: readonly ParsedRetainedSourceRow[],
  nativeCurrency?: string,
): RetainedSourceClaims {
  const combined: MutableRetainedClaims = {};
  for (const row of rows)
    for (const [key, value] of Object.entries(row.claims ?? {})) {
      const name = key as RetainedSourceClaimName;
      if (combined[name] !== undefined && combined[name] !== value)
        throw new BenefitsError(
          "REFUSED",
          `retained source documents disagree on ${key}; reconcile the selected evidence before recording`,
        );
      combined[name] = value;
    }
  if (nativeCurrency !== undefined) {
    if (
      !/^[A-Z]{3}$/.test(nativeCurrency) ||
      (combined.currency !== undefined && combined.currency !== nativeCurrency)
    )
      throw new BenefitsError(
        "REFUSED",
        "retained currency evidence contradicts the reviewed native program currency",
      );
    combined.currency = nativeCurrency;
    for (const row of rows) {
      const codes = Array.isArray(row.row.printedCurrencyCodes)
        ? [...row.row.printedCurrencyCodes]
        : [];
      for (const key of ["currency", "currencyCode", "currency_code"]) {
        const code = row.row[key];
        if (typeof code === "string" && /^[A-Z]{3}$/i.test(code)) codes.push(code.toUpperCase());
      }
      if (codes.some((code) => code !== nativeCurrency))
        throw new BenefitsError(
          "REFUSED",
          "a retained document declares a currency that contradicts the reviewed native payroll currency",
        );
    }
  }
  for (const key of [
    "sourceRowRef",
    "value",
    "currency",
    "periodFrom",
    "periodTo",
    "sourceIssueDate",
  ] as const) {
    if (combined[key] === undefined)
      throw new BenefitsError(
        "REFUSED",
        `retained source evidence must bind ${key}; select its source field or reviewed native currency basis`,
      );
  }
  return combined as RetainedSourceClaims;
}
