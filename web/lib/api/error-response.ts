import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { postingRefusal } from "./responses";
import { readerRefusal } from "../reader-refusal";
import { isCatalogRefusal } from "../refusal-catalog";

/** A typed refusal is safe to show only when its class names the business condition and its status is 4xx. */
/**
 * A typed business refusal: a named error class (never a plain Error) with a
 * 4xx `status` or `statusCode`, or `safeStatus` when it carries neither. Only
 * these are safe to show; anything else is an unexpected failure.
 */
export function typedRefusal(
  error: unknown,
  safeStatus?: number,
): error is Error & { status?: number; statusCode?: number } {
  if (!(error instanceof Error) || error.constructor === Error) return false;
  const status =
    "status" in error ? error.status : "statusCode" in error ? error.statusCode : safeStatus;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * A refusal in the reader's language: a catalog-backed refusal renders its
 * message and remedy from the locale catalogs with its figures (share
 * counts, amounts, prices, dates, field names) formatted for the reader; a
 * refusal that renders its own figures for a locale does so. Outside a
 * request either keeps its own rendering.
 */
export async function readerRefusalText(
  error: Error,
): Promise<{ message: string; remedy: string } | null> {
  if (isCatalogRefusal(error)) return readerRefusal(error);
  const localized = (error as Error & { localized?: unknown }).localized;
  if (typeof localized !== "function") return null;
  let locale: string | null = null;
  try {
    locale = await getLocale();
  } catch {
    return null;
  }
  const text = (localized as (locale: string) => unknown).call(error, locale);
  if (!text || typeof text !== "object") return null;
  const { message, remedy } = text as { message?: unknown; remedy?: unknown };
  return typeof message === "string" && typeof remedy === "string" ? { message, remedy } : null;
}

/** Shared API boundary for typed business refusals and unexpected failures. */
export async function apiErrorResponse(
  error: unknown,
  options: { request?: Request; safeStatus?: number; details?: Record<string, unknown> } = {},
): Promise<NextResponse> {
  if (typedRefusal(error, options.safeStatus)) {
    const status = (
      "status" in error
        ? error.status
        : "statusCode" in error
          ? error.statusCode
          : options.safeStatus
    ) as number;
    // A typed business refusal's remedy is part of its public result. Keep
    // only its named contract fields; unrelated Error internals stay private.
    // `details` carries structured evidence (never internals): plain objects
    // only, so a stray class instance or circular value cannot leak or crash
    // the serializer.
    const metadata: Record<string, unknown> = {};
    for (const key of ["code", "remedy", "field"] as const) {
      const value = (error as Error & { code?: unknown; remedy?: unknown; field?: unknown })[key];
      if (typeof value === "string" && value.trim() !== "") metadata[key] = value;
    }
    const details = (error as Error & { details?: unknown }).details;
    if (details !== null && typeof details === "object" && !Array.isArray(details)) {
      metadata.details = details;
    }
    const reader = await readerRefusalText(error);
    if (reader)
      return NextResponse.json(
        { ...metadata, ...options.details, error: reader.message, remedy: reader.remedy },
        { status },
      );
    return NextResponse.json({ error: error.message, ...metadata, ...options.details }, { status });
  }

  // A status-less engine refusal is still a domain refusal, never a 500:
  // the shared family table answers it with its 4xx, code, remedy, and
  // structured details (a closed period's locked scope). Only genuine class
  // members map — a plain Error with forged fields still falls through to
  // the unknown-error path below.
  const refusal = postingRefusal(error);
  if (refusal) return refusal;

  const requestId = randomUUID();
  console.error("Unhandled API error", {
    requestId,
    error,
    path: options.request ? new URL(options.request.url).pathname : undefined,
  });
  let message = `An unexpected error occurred. Please try again. If the problem continues, contact support with request ID ${requestId}.`;
  try {
    const t = await getTranslations("apiErrors");
    message = t("internalError", { requestId });
  } catch {
    // The fallback is used by route contexts that do not carry an intl request store.
  }
  return NextResponse.json(
    { error: message, requestId },
    { status: 500, headers: { "x-request-id": requestId } },
  );
}
