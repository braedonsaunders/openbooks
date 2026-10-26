"use client";

import { useState } from "react";
import { Loader2, Plus, Save } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button, Drawer } from "@openbooks/ui";
import { CATEGORY_LABEL_KEYS, type WidgetCategory, type WidgetMeta } from "./_widget-registry";
import type { RoleTier } from "./_role-tier";
import { widgetsForRole } from "./_widget-registry";
import type { DashboardApp } from "./_app-widget";
import { NavIcon } from "@/components/sidebar-nav";
import { appWidgetId } from "@/lib/apps/surfaces";
import { SearchInput } from "@/components/search-input";

type LibraryCard = { id: string; name: string; description: string };

interface WidgetPaletteProps {
  role: RoleTier;
  presentIds: string[] | Set<string>;
  onAdd: (widget: WidgetMeta) => void;
  libraryCards: LibraryCard[];
  onAddCard: (card: { id: string }) => void;
  apps: DashboardApp[];
  onAddApp: (app: DashboardApp) => void;
  allowedWidgetIds: readonly string[] | Set<string> | undefined;
  onClose: () => void;
  /**
   * Save the customize draft without closing the picker. The drawer's
   * backdrop covers the header toolbar, so without this the operator cannot
   * reach Save while picking widgets. Mirrors the toolbar's enabled state.
   */
  onSave?: () => void;
  saving?: boolean;
  canSave?: boolean;
}

export function WidgetPalette({
  role,
  presentIds,
  onAdd,
  libraryCards,
  onAddCard,
  apps,
  onAddApp,
  allowedWidgetIds,
  onClose,
  onSave,
  saving = false,
  canSave = false,
}: WidgetPaletteProps) {
  const t = useTranslations("dashboard");
  const tApps = useTranslations("apps");
  const present = presentIds instanceof Set ? presentIds : new Set(presentIds);
  const allowed =
    allowedWidgetIds instanceof Set ? allowedWidgetIds : new Set(allowedWidgetIds ?? []);

  const [query, setQuery] = useState("");
  // Every word must appear in the entry's name, description or section, in
  // the viewer's language — the same text the palette shows.
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...text: (string | undefined)[]) => {
    const haystack = text.filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  const available = widgetsForRole(role).filter(
    (w) =>
      !present.has(w.id) &&
      allowed.has(w.id) &&
      matches(t(w.labelKey), t(w.descriptionKey), t(CATEGORY_LABEL_KEYS[w.category])),
  );
  const availableApps = apps.filter(
    (app) =>
      !present.has(appWidgetId(app.key)) && matches(app.name, app.description, tApps("title")),
  );
  const shownCards = libraryCards.filter((card) =>
    matches(card.name, card.description, t("palette.libraryCards")),
  );

  const byCategory = new Map<WidgetCategory, WidgetMeta[]>();
  for (const w of available) {
    const arr = byCategory.get(w.category) ?? [];
    arr.push(w);
    byCategory.set(w.category, arr);
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="sm"
      title={t("palette.title")}
      description={t("palette.subtitle")}
      bodyClassName="overflow-y-auto p-3"
      footer={
        onSave ? (
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || !canSave}
            className="h-8 text-xs"
          >
            {saving ? (
              <Loader2 size={13} className="mr-1 animate-spin" />
            ) : (
              <Save size={13} className="mr-1" />
            )}
            {t("grid.save")}
          </Button>
        ) : undefined
      }
    >
      <div className="sticky -top-3 z-10 -mx-3 -mt-3 mb-3 border-b border-slate-100 bg-white/95 px-3 pt-3 pb-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
        <SearchInput
          size="md"
          value={query}
          onValueChange={setQuery}
          placeholder={t("palette.searchPlaceholder")}
          className="w-full sm:w-full sm:max-w-none"
        />
      </div>

      {byCategory.size === 0 && shownCards.length === 0 && availableApps.length === 0 ? (
        <p className="px-2 py-4 text-sm text-slate-400">
          {terms.length > 0 ? t("palette.noMatches", { query: query.trim() }) : t("palette.empty")}
        </p>
      ) : null}

      {[...byCategory.entries()].map(([cat, widgets]) => (
        <div key={cat} className="mb-4">
          <h3 className="mb-2 px-1 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t(CATEGORY_LABEL_KEYS[cat])}
          </h3>
          <div className="space-y-1">
            {widgets.map((w) => (
              <button
                key={w.id}
                onClick={() => onAdd(w)}
                className="flex w-full items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:border-teal-700 dark:hover:bg-teal-950/30"
              >
                <Plus size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t(w.labelKey)}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t(w.descriptionKey)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {shownCards.length > 0 ? (
        <div className="mb-4">
          <h3 className="mb-2 px-1 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {t("palette.libraryCards")}
          </h3>
          <div className="space-y-1">
            {shownCards.map((c) => (
              <button
                key={c.id}
                onClick={() => onAddCard(c)}
                className="flex w-full items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:border-teal-700 dark:hover:bg-teal-950/30"
              >
                <Plus size={15} className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{c.name}</p>
                  {c.description ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">{c.description}</p>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {availableApps.length > 0 ? (
        <div className="mb-4">
          <h3 className="mb-2 px-1 text-xs font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
            {tApps("title")}
          </h3>
          <div className="space-y-1">
            {availableApps.map((app) => (
              <button
                key={app.key}
                onClick={() => onAddApp(app)}
                className="flex w-full items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-left transition-colors hover:border-teal-300 hover:bg-teal-50/50 dark:border-slate-800 dark:hover:border-teal-700 dark:hover:bg-teal-950/30"
              >
                <span className="mt-0.5 shrink-0 text-teal-600 dark:text-teal-400">
                  <NavIcon iconKey={app.iconKey} size={15} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {app.name}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {app.description || tApps("noDescription")}
                  </p>
                </div>
                <Plus
                  size={15}
                  className="ml-auto mt-0.5 shrink-0 text-teal-600 dark:text-teal-400"
                />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
