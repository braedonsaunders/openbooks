import { canonicalDecimal } from "../money/exact-decimal.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import type { Money } from "../money/brands.ts";
import {
  decimalNullCause,
  decimalNullRefusal,
  type DecimalNullCause,
} from "../money/decimal-refusal.ts";
import {
  guardedFetch,
  resolveVerifiedAddresses,
  type AddressLookup,
} from "../connectors/ssrf-guard.ts";

/**
 * Shared Azure Document Intelligence transport and field readers. Vendor bill
 * capture (prebuilt-invoice) and expense receipt capture (prebuilt-receipt)
 * submit through the same verified endpoint, SSRF-guarded fetch and exact
 * decimal readers; only the model and the field contract differ.
 */

export type { AddressLookup };

export const AZURE_DOCUMENT_INTELLIGENCE_API_VERSION = "2024-11-30";

/** Reject mislabeled uploads before they enter the evidence store or provider queue. */
export function captureContentMatchesMime(bytes: Uint8Array, contentType: string): boolean {
  const prefix = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (contentType === "application/xml" || contentType === "text/xml") {
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/^\uFEFF/, "")
        .trimStart()
        .startsWith("<");
    } catch {
      return false;
    }
  }
  if (contentType === "application/pdf") return prefix(0x25, 0x50, 0x44, 0x46);
  if (contentType === "image/jpeg") return prefix(0xff, 0xd8, 0xff);
  if (contentType === "image/png") return prefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (contentType === "image/tiff") {
    return prefix(0x49, 0x49, 0x2a, 0x00) || prefix(0x4d, 0x4d, 0x00, 0x2a);
  }
  return false;
}

export type CaptureEvidence = {
  fieldKey: string;
  lineIndex: number | null;
  rawValue: string | null;
  normalizedValue: unknown;
  confidence: string | null;
  pageNumber: number | null;
  polygon: { points: number[]; width: number; height: number } | null;
};

export type CaptureIssue = {
  code: string;
  severity: "blocking" | "warning";
  field?: string;
  lineIndex?: number;
  expected?: string;
  actual?: string;
  /**
   * Stable catalog interpolation data. For invalid_amount issues `cause`
   * carries the decimalNullCause discriminant and `expected`/`detail` its
   * remedy tokens (rewrite, separator/symbol, or counts); `actual` always
   * carries the raw supplied value. The review drawer renders these through
   * the active locale catalog.
   */
  cause?: string;
  detail?: string;
  /**
   * The operator-facing refusal naming the remedy, in server English. Kept
   * for non-UI consumers and as the fallback for codes (or causes) a client
   * bundle does not know yet; the review drawer prefers its catalog text.
   */
  message?: string;
};

export type AzureRegion = { pageNumber?: number; polygon?: number[] };
export type AzureField = {
  type?: string;
  content?: string;
  confidence?: number;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueCurrency?: { amount?: number; currencyCode?: string; currencySymbol?: string };
  valueAddress?: Record<string, string>;
  valuePhoneNumber?: string;
  valueArray?: AzureField[];
  valueObject?: Record<string, AzureField>;
  boundingRegions?: AzureRegion[];
};
export type AzureAnalyzeResponse = {
  status?: string;
  error?: { code?: string; message?: string };
  analyzeResult?: {
    documents?: Array<{
      docType?: string;
      confidence?: number;
      fields?: Record<string, AzureField>;
    }>;
    pages?: Array<{ pageNumber?: number; width?: number; height?: number }>;
    content?: string;
  };
};

/** Provider confidence as a bounded four-place decimal string, or null when absent. */
export function azureFieldConfidence(field: AzureField | undefined): string | null {
  if (field?.confidence === undefined || !Number.isFinite(field.confidence)) return null;
  const bounded = Math.min(1, Math.max(0, field.confidence));
  return bounded.toFixed(4);
}

export function azureFieldText(field: AzureField | undefined): string | null {
  if (!field) return null;
  if (typeof field.valueString === "string") return field.valueString.trim() || null;
  if (typeof field.valueDate === "string") return field.valueDate.trim() || null;
  if (field.valueAddress) {
    const a = field.valueAddress;
    const parts = [a.houseNumber, a.road, a.city, a.state, a.postalCode, a.countryRegion].filter(
      Boolean,
    );
    if (parts.length) return parts.join(", ");
  }
  return field.content?.trim() || null;
}

/**
 * The boundary where captured text becomes a validated amount: every
 * non-null exit is fromUnits-fixed canonical Money. Null means absent or
 * refused; it never uses floating money math.
 */
export function normalizeCapturedDecimal(value: unknown): Money | null {
  if (value === null || value === undefined || value === "") return null;
  let raw = String(value)
    .trim()
    .replace(/[\u00a0\s]/g, "");
  if (/^[-+]?(\d+(\.\d*)?|\.\d+)[eE][-+]?\d+$/.test(raw)) return fromUnits(toUnits(raw)) as Money;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith("-");
  raw = raw
    .replace(/[()]/g, "")
    .replace(/^[+-]/, "")
    .replace(/[^0-9.,]/g, "");
  if (!raw) return null;

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? "," : ".";
    const thousands = decimal === "," ? /\./g : /,/g;
    raw = raw.replace(thousands, "").replace(decimal, ".");
  } else if (lastComma >= 0) {
    // A lone comma is two readings, never a guess: let the shared decimal
    // classifier decide. Ambiguous text ("1,234") is refused by name, the
    // decimal-comma reading ("12,34") keeps its dotted value, and pure
    // grouping ("1,234,567") strips. A typed provider number never reaches
    // this branch — String(number) has no comma — so nothing canonical is lost.
    const cause = decimalNullCause(`${negative ? "-" : ""}${raw}`);
    if (cause.cause === "ambiguous-comma") return null;
    if (cause.cause === "decimal-comma") raw = raw.replace(/,/g, ".");
    else if (cause.cause === "separator") raw = raw.replace(/,/g, "");
    else return null;
  } else if ((raw.match(/\./g) ?? []).length > 1) {
    // Two or more dots is two readings, never a guess: "1.234.567" is
    // one-point-two million in every dot-grouped locale (DE, IT, ES) and a
    // misread decimal in others, and a last-dot-is-the-point rule would turn
    // the German reading into 1234.567 — a 1000x understated total that
    // looks plausible in review. Refuse instead: the raw text rides through
    // as `supplied` so the reviewer sees what the document said.
    return null;
  }
  const signed = `${negative ? "-" : ""}${raw}`;
  return fromUnits(toUnits(signed)) as Money;
}

/**
 * A captured money reading with its provenance split: `canonical` is ledger
 * money, `supplied` is raw OCR text the parser refused. Typed numeric fields
 * do not carry comma-separator ambiguity; raw supplied text must survive
 * refusal so every boundary can name it.
 */
export function azureCapturedMoney(field: AzureField | undefined): {
  canonical: Money | null;
  supplied: string | null;
} {
  if (!field) return { canonical: null, supplied: null };
  const typed = field.valueCurrency?.amount ?? field.valueNumber;
  if (typeof typed === "number") {
    if (!Number.isFinite(typed)) return { canonical: null, supplied: null };
    return { canonical: normalizeCapturedDecimal(typed), supplied: null };
  }
  const text = typeof typed === "string" ? typed : field.content;
  if (typeof text === "number")
    return { canonical: normalizeCapturedDecimal(text), supplied: null };
  if (typeof text !== "string" || text.trim() === "") return { canonical: null, supplied: null };
  const canonical = normalizeCapturedDecimal(text);
  return canonical === null
    ? { canonical: null, supplied: text.trim() }
    : { canonical, supplied: null };
}

export function azureEvidence(
  fieldKey: string,
  field: AzureField,
  normalizedValue: unknown,
  lineIndex: number | null,
): CaptureEvidence {
  const region = field.boundingRegions?.[0];
  return {
    fieldKey,
    lineIndex,
    rawValue: field.content ?? azureFieldText(field),
    normalizedValue,
    confidence: azureFieldConfidence(field),
    pageNumber: region?.pageNumber ?? null,
    polygon: region?.polygon ? { points: region.polygon, width: 0, height: 0 } : null,
  };
}

/** Attach page geometry to evidence polygons; a polygon without a known page is dropped. */
export function applyAzurePageGeometry(
  raw: AzureAnalyzeResponse,
  evidence: CaptureEvidence[],
): void {
  const pages = new Map(
    (raw.analyzeResult?.pages ?? [])
      .filter((page) => page.pageNumber && page.width && page.height)
      .map((page) => [page.pageNumber!, { width: page.width!, height: page.height! }]),
  );
  for (const field of evidence) {
    const page = field.pageNumber ? pages.get(field.pageNumber) : undefined;
    if (field.polygon && page) field.polygon = { ...field.polygon, ...page };
    else field.polygon = null;
  }
}

/** Overall document confidence, bounded to [0, 1], or null when the provider omitted it. */
export function azureDocumentConfidence(document: { confidence?: number }): string | null {
  return document.confidence === undefined || !Number.isFinite(document.confidence)
    ? null
    : Math.min(1, Math.max(0, document.confidence)).toFixed(4);
}

const MAX_NUMERIC_19_4_UNITS = 9_999_999_999_999_999_999n;

/** True when a canonical amount fits numeric(19,4). */
export function withinNumeric19_4(value: string): boolean {
  const units = toUnits(value);
  return units >= -MAX_NUMERIC_19_4_UNITS && units <= MAX_NUMERIC_19_4_UNITS;
}

/** Ledger-canonical money or quantity text, the only shape math may read. */
export function isCanonicalMoney(value: string): boolean {
  return canonicalDecimal(value, 4) !== null;
}

export function invalidMoneyIssue(
  fieldLabel: string,
  noun: string,
  raw: string,
  extra: Partial<CaptureIssue> = {},
  maxScale = 4,
): CaptureIssue {
  const cause = decimalNullCause(raw);
  return {
    code: "invalid_amount",
    severity: "blocking",
    actual: raw,
    cause: cause.cause,
    ...causeRemedyTokens(cause, maxScale),
    message: decimalNullRefusal(fieldLabel, noun, raw, maxScale),
    ...extra,
  };
}

/** Catalog remedy tokens for one decimal refusal, keyed by its cause. */
function causeRemedyTokens(cause: DecimalNullCause, maxScale: number): Partial<CaptureIssue> {
  switch (cause.cause) {
    case "scale":
      return { expected: String(maxScale), detail: String(maxScale) };
    case "separator":
      return { expected: cause.separator };
    case "decimal-comma":
      return { expected: cause.dotted };
    case "ambiguous-comma":
      return { expected: cause.grouped, detail: cause.dotted };
    case "currency":
      return { expected: cause.symbol };
    default:
      return {};
  }
}

/**
 * A document-provider endpoint refusal: the configured endpoint is missing,
 * malformed, insecure, or unreachable. It answers 422 with its remedy — the
 * hostname it names is the operator's own configured endpoint, never a
 * driver or network internal. Anything else (a driver or DNS failure shaped
 * differently) stays unexpected.
 */
export class DocumentEndpointError extends Error {
  readonly status = 422;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentEndpointError";
  }
}

export function validateAzureDocumentEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new DocumentEndpointError(
      "Document provider endpoint is not a valid URL — check the endpoint under Platform → AI",
    );
  }
  if (endpoint.protocol !== "https:")
    throw new DocumentEndpointError("Document provider endpoint must use HTTPS");
  const host = endpoint.hostname.toLowerCase();
  if (!(
    host.endsWith(".cognitiveservices.azure.com") || host.endsWith(".api.cognitive.microsoft.com")
  )) {
    throw new DocumentEndpointError(
      "Document provider endpoint is not an Azure Document Intelligence endpoint",
    );
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

/**
 * Enforcement-time endpoint check: the suffix pin above plus live DNS
 * resolution requiring every resolved address to be public unicast. The
 * suffix alone fetches nothing, so a stale or rebinding hostname would pass
 * validation and fail (or worse, connect) later; every request below
 * re-resolves through guardedFetch anyway, and this fails the
 * misconfiguration closed before any credential is sent.
 */
export async function verifyAzureDocumentEndpoint(
  value: string,
  lookupAddresses?: AddressLookup,
): Promise<URL> {
  const endpoint = validateAzureDocumentEndpoint(value);
  try {
    await resolveVerifiedAddresses(endpoint, lookupAddresses);
  } catch (error) {
    throw new DocumentEndpointError(
      `Document provider endpoint ${endpoint.hostname} did not resolve to a public address — check the endpoint under Platform → AI`,
      { cause: error },
    );
  }
  return endpoint;
}

async function providerError(response: Response): Promise<string> {
  const body = await response.text();
  let parsed: { error?: { message?: string }; message?: string } | null = null;
  try {
    parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
  } catch {
    parsed = null;
  }
  // The provider's structured message names the fault; the raw body never
  // leaves this function — echoing it would embed response HTML and
  // document bytes into operator-facing errors.
  const message = parsed?.error?.message ?? parsed?.message;
  if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  return `HTTP ${response.status}`;
}

/**
 * Production Azure REST adapter: submit bytes to one model, poll
 * asynchronously, and return the succeeded raw analysis for the caller's
 * field contract to normalize.
 */
export async function analyzeAzureDocument(input: {
  endpoint: string;
  apiKey: string;
  model: string;
  contentType: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<AzureAnalyzeResponse> {
  const endpoint = await verifyAzureDocumentEndpoint(input.endpoint, input.lookup);
  const model = input.model.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63}$/.test(model))
    throw new Error("Invalid document model id");
  if (!input.apiKey.trim()) throw new Error("Document provider API key is missing");
  // Operator-configured host: resolve-and-pin per request with no redirects,
  // never the ambient fetch that follows Location anywhere with the key.
  const runFetch: typeof fetch =
    input.fetchImpl ?? ((url, init) => guardedFetch(url, init ?? {}, { lookup: input.lookup }));
  const url = new URL(
    `${endpoint.pathname}/documentintelligence/documentModels/${encodeURIComponent(model)}:analyze`,
    endpoint,
  );
  url.searchParams.set("api-version", AZURE_DOCUMENT_INTELLIGENCE_API_VERSION);
  const submitted = await runFetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": input.apiKey,
      "Content-Type": input.contentType,
    },
    body: Buffer.from(input.bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (submitted.status !== 202)
    throw new Error(`Document provider submission failed: ${await providerError(submitted)}`);
  const operation = submitted.headers.get("operation-location");
  if (!operation) throw new Error("Document provider omitted the operation location");
  const operationUrl = new URL(operation);
  if (operationUrl.origin !== endpoint.origin)
    throw new Error("Document provider returned an unexpected operation host");

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (attempt > 0)
      await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, 1_000 + attempt * 200)));
    const polled = await runFetch(operationUrl, {
      headers: { "Ocp-Apim-Subscription-Key": input.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!polled.ok)
      throw new Error(`Document provider polling failed: ${await providerError(polled)}`);
    const raw = (await polled.json()) as AzureAnalyzeResponse;
    const status = raw.status?.toLowerCase();
    if (status === "failed")
      throw new Error(raw.error?.message ?? "Document provider analysis failed");
    if (status === "succeeded") return raw;
    if (status !== "running" && status !== "notstarted") {
      throw new Error(`Document provider returned unknown status: ${raw.status ?? "missing"}`);
    }
  }
  throw new Error("Document provider analysis timed out");
}

/** Live, non-mutating credential check used by Platform → AI. */
export async function testAzureDocumentProvider(input: {
  endpoint: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  lookup?: AddressLookup;
}): Promise<{ ok: boolean; message: string }> {
  try {
    const endpoint = await verifyAzureDocumentEndpoint(input.endpoint, input.lookup);
    if (!input.apiKey.trim()) return { ok: false, message: "Document provider API key is missing" };
    const url = new URL(`${endpoint.pathname}/documentintelligence/documentModels`, endpoint);
    url.searchParams.set("api-version", AZURE_DOCUMENT_INTELLIGENCE_API_VERSION);
    const runFetch: typeof fetch =
      input.fetchImpl ??
      ((fetchUrl, init) => guardedFetch(fetchUrl, init ?? {}, { lookup: input.lookup }));
    const response = await runFetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": input.apiKey },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return { ok: false, message: (await providerError(response)).slice(0, 180) };
    return { ok: true, message: "Connected to the document provider" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 180) : "Connection failed",
    };
  }
}
