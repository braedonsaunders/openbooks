"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

/** Closed-period scope behind a posting refusal: exactly what a reopen request must cover. */
export interface PeriodClosedScope {
  periodId: string;
  bookId: string;
  subsidiaryId: string | null;
  module: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function scopeFromDetails(details: unknown): PeriodClosedScope | null {
  const record = asRecord(details);
  if (!record || record.kind !== "period-closed") return null;
  const periodId = cleanId(record.periodId);
  const bookId = cleanId(record.bookId);
  const module = cleanId(record.module);
  if (!periodId || !bookId || !module) return null;
  // An entity id that is present but unusable fails closed: no link rather
  // than a link requesting the wrong scope.
  if (record.subsidiaryId != null && cleanId(record.subsidiaryId) == null) return null;
  return { periodId, bookId, subsidiaryId: cleanId(record.subsidiaryId), module };
}

/**
 * Typed closed-period scope behind any refusal that preserved it: the
 * app's own result readers attach the body's details to the pinned error,
 * `apiJson` callers keep the raw body, and previews may hand the body
 * itself. Anything else — including a closed-period message without
 * details — yields null so callers never link from parsed text.
 */
export function periodClosedScopeOf(error: unknown): PeriodClosedScope | null {
  if (error == null) return null;
  const holders = [
    (error as { details?: unknown }).details,
    asRecord((error as { body?: unknown }).body)?.details,
    error,
  ];
  for (const holder of holders) {
    const scope = scopeFromDetails(holder);
    if (scope) return scope;
  }
  return null;
}

/**
 * Setup deep link opening the reopen request form prefilled with the
 * refused scope: the period drawer opens on the period and book with the
 * module's reopen form armed (and the entity carried through).
 */
export function reopenRequestHref(scope: PeriodClosedScope): string {
  const params = new URLSearchParams({
    tab: "periods",
    period: scope.periodId,
    book: scope.bookId,
    reopenModule: scope.module,
  });
  if (scope.subsidiaryId) params.set("reopenEntity", scope.subsidiaryId);
  return `/admin/setup/period-close?${params.toString()}`;
}

/**
 * The shared period-closed refusal renderer: a "request a controlled
 * reopening" link into the prefilled reopen form, rendered beside (never
 * instead of) the refusal message the shared alert already pins. Null for
 * every refusal that is not a typed closed period.
 */
export function PeriodClosedRefusal({ error }: { error: unknown }) {
  const t = useTranslations("close.setup");
  const scope = periodClosedScopeOf(error);
  if (!scope) return null;
  return (
    <p className="text-sm">
      <Link
        className="font-medium text-teal-700 underline dark:text-teal-300"
        href={reopenRequestHref(scope)}
      >
        {t("periods.requestReopenLink")}
      </Link>
    </p>
  );
}
