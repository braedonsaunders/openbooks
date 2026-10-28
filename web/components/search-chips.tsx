"use client";

import { useLocale, useTranslations } from "next-intl";
import { X } from "lucide-react";
import { formatCivilDate } from "../lib/format";
import type { SearchChip } from "../lib/search-types";

/**
 * Whole cents (a decimal string) in the reader's number format, without
 * passing through floating point: the integer part groups through Intl as a
 * BigInt and the cents follow the locale's decimal separator.
 */
export function centsLabel(cents: string, locale: string): string {
  const digits = cents.replace(/^0+(?=\d)/, "").padStart(3, "0");
  const whole = BigInt(digits.slice(0, -2));
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).formatToParts(1.5);
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  return `${new Intl.NumberFormat(locale).format(whole)}${decimal}${digits.slice(-2)}`;
}

/** A chip's label in the reader's language. */
export function useChipLabel(): (chip: SearchChip) => string {
  const t = useTranslations("shell.globalSearch.chips");
  const locale = useLocale();
  return (chip) => {
    switch (chip.kind) {
      case "scope":
        return t(`scope.${chip.scope}` as never);
      case "status":
        return t(`status.${chip.status}` as never);
      case "amount": {
        const amount = centsLabel(chip.value, locale);
        if (chip.op === "range")
          return t("amount.range", {
            min: centsLabel(chip.min, locale),
            max: centsLabel(chip.max ?? chip.min, locale),
          });
        return t(`amount.${chip.op}` as never, { amount } as never);
      }
      case "date": {
        if (chip.from && chip.to && chip.from === chip.to)
          return t("date.on", { date: formatCivilDate(chip.from, locale) });
        if (chip.from && chip.to)
          return t("date.range", {
            from: formatCivilDate(chip.from, locale),
            to: formatCivilDate(chip.to, locale),
          });
        if (chip.from) return t("date.since", { date: formatCivilDate(chip.from, locale) });
        return t("date.through", { date: formatCivilDate(chip.to ?? "", locale) });
      }
    }
  };
}

/**
 * What the query was understood to mean, one removable chip per part.
 * Removing a chip removes the words it came from, so the reader can undo
 * any reading; quoting the words keeps them literal instead.
 */
export function SearchChips({
  chips,
  onRemove,
  className,
}: {
  chips: readonly SearchChip[];
  onRemove: (chip: SearchChip) => void;
  className?: string;
}) {
  const t = useTranslations("shell.globalSearch.chips");
  const label = useChipLabel();
  if (chips.length === 0) return null;
  return (
    <div className={className} role="group" aria-label={t("label")}>
      <span className="text-[11px] text-slate-400 dark:text-slate-500">{t("label")}</span>
      {chips.map((chip) => {
        const text = label(chip);
        return (
          <span
            key={`${chip.kind}-${chip.start}`}
            className="inline-flex items-center gap-1 rounded-full border border-teal-200 bg-teal-50 py-0.5 pr-1 pl-2 text-[11px] font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/40 dark:text-teal-200"
          >
            {text}
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemove(chip)}
              className="rounded-full p-0.5 text-teal-600 hover:bg-teal-100 hover:text-teal-900 dark:text-teal-300 dark:hover:bg-teal-900"
              aria-label={t("remove", { label: text })}
            >
              <X size={11} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
