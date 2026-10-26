"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { cn } from "@openbooks/ui";
import { useEntryPreferences } from "../lib/entry-preferences-context";
import type { EntryPreferences } from "../lib/entry-preferences";

type BooleanPreference =
  "enterMovesToNextField" | "autoDecimal" | "keepDateOnNew" | "keepPartyOnNew";

const SWITCHES: readonly BooleanPreference[] = [
  "enterMovesToNextField",
  "autoDecimal",
  "keepDateOnNew",
  "keepPartyOnNew",
];
const RECALL_MODES: readonly EntryPreferences["recallLastDocument"][] = ["suggest", "apply", "off"];

/**
 * The person's data-entry preferences: how Enter moves, ten-key amounts,
 * what Save & new carries, and last-document recall. Each change saves at
 * once and applies to every form without a reload.
 */
export function EntryPreferencesPanel({ className }: { className?: string }) {
  const t = useTranslations("entry.preferences");
  const { preferences, update } = useEntryPreferences();
  const [saving, setSaving] = useState<string | null>(null);

  async function change(patch: Partial<EntryPreferences>, key: string) {
    setSaving(key);
    const ok = await update(patch);
    setSaving(null);
    if (!ok) toast.error(t("saveFailed"));
  }

  return (
    <div className={cn("space-y-1 p-1", className)}>
      {SWITCHES.map((key) => (
        <label
          key={key}
          className="flex cursor-pointer items-start gap-3 rounded-md px-2.5 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/60"
        >
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-teal-600"
            checked={preferences[key]}
            disabled={saving !== null}
            onChange={(event) => void change({ [key]: event.target.checked }, key)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
              {t(`${key}.label`)}
            </span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              {t(`${key}.help`)}
            </span>
          </span>
        </label>
      ))}
      <fieldset className="rounded-md px-2.5 py-2">
        <legend className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t("recallLastDocument.label")}
        </legend>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("recallLastDocument.help")}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup">
          {RECALL_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={preferences.recallLastDocument === mode}
              disabled={saving !== null}
              onClick={() => void change({ recallLastDocument: mode }, "recallLastDocument")}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                preferences.recallLastDocument === mode
                  ? "border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-600 dark:bg-teal-950/50 dark:text-teal-200"
                  : "border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              {t(`recallLastDocument.${mode}`)}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
