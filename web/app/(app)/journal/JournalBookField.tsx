"use client";

import { useTranslations } from "next-intl";
import { Label, SearchSelect } from "@openbooks/ui";

export interface JournalBookOption {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

/**
 * The journal's accounting book. "All books" is the standard journal: it
 * posts to the primary book and replicates into every full book. Choosing a
 * book makes the journal book-specific — it posts to that book only (the
 * primary book included), in the currency that book keeps for the journal's
 * subsidiary. Only holders of the book-specific posting permission choose.
 */
export function JournalBookField({
  books,
  value,
  onChange,
  editable,
}: {
  books: JournalBookOption[];
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
}) {
  const t = useTranslations("journal.book");
  const label = (book: JournalBookOption) =>
    `${book.name} (${book.code})${book.isPrimary ? ` · ${t("primary")}` : ""}`;
  const selected = books.find((book) => book.id === value);
  return (
    <div className="space-y-1.5 sm:max-w-sm">
      <Label>{t("label")}</Label>
      {editable ? (
        <>
          <SearchSelect
            options={books.map((book) => ({ value: book.id, label: label(book) }))}
            value={value}
            onChange={(next) => onChange(next ?? "")}
            clearable
            emptyLabel={t("allBooks")}
            placeholder={t("allBooks")}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {value ? t("specificHint") : t("allBooksHint")}
          </p>
        </>
      ) : (
        <p className="text-sm">{selected ? label(selected) : t("allBooks")}</p>
      )}
    </div>
  );
}
