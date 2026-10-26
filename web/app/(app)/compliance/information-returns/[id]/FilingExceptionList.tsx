"use client";

import { useTranslations } from "next-intl";

export interface FilingExceptionRow {
  kind: string;
  partyName: string;
  message: string;
  remedy: string;
}

/**
 * The exceptions a compute surfaced, each with what is wrong and the remedy
 * that clears it. Both strings come from the engine's guidance function, the
 * same wording finalize refuses with, so this list and a finalize refusal
 * always name the same fix for a vendor.
 */
export function FilingExceptionList({ exceptions }: { exceptions: FilingExceptionRow[] }) {
  const t = useTranslations("compliance");
  if (exceptions.length === 0) return null;
  return (
    <section
      aria-label={t("informationReturns.exceptions.title")}
      className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {t("informationReturns.exceptions.title")}
      </h3>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {exceptions.map((exception, index) => (
          <li key={`${exception.kind}-${index}`} className="space-y-1 py-2">
            <p className="text-sm text-slate-900 dark:text-slate-100">{exception.message}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <span className="font-medium">{t("informationReturns.exceptions.remedy")}:</span>{" "}
              {exception.remedy}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
