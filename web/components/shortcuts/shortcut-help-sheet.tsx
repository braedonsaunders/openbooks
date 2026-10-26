"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import { Drawer, Input } from "@openbooks/ui";
import { RecordTabs } from "../module-home/record-tabs";
import { SHORTCUT_REFERENCE_GROUPS, type ShortcutReference } from "./shortcut-catalog";
import { EDITOR_SHORTCUT_REFERENCE } from "./editor-shortcut-catalog";
import {
  bindingKeys,
  currentPlatform,
  SCOPE_ORDER,
  shortcutLabel,
  type RegisteredShortcut,
} from "./shortcut-keys";
import { EntryPreferencesPanel } from "../entry-preferences-panel";

const KEY_CAP =
  "inline-flex min-w-[1.5rem] items-center justify-center rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[11px] font-medium text-slate-600 shadow-[0_1px_0_rgba(15,23,42,0.08)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";

function KeyCaps({ keys, separator }: { keys: readonly string[]; separator?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {separator && index > 0 ? (
            <span className="text-[11px] text-slate-400 dark:text-slate-500">{separator}</span>
          ) : null}
          <kbd className={KEY_CAP}>{key}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2 text-sm text-slate-700 dark:text-slate-200">
      <span className="min-w-0">{label}</span>
      {children}
    </li>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
        {title}
      </h3>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
    </section>
  );
}

/** Resolve the actual platform binding; an alias for another platform stays hidden. */
export function referenceKeys(
  entry: ShortcutReference,
  apple: boolean,
  linux = false,
): readonly string[] {
  if (entry.binding) return bindingKeys(entry.binding, apple);
  if (entry.editorBinding) {
    const binding = entry.editorBinding;
    const raw = (apple ? binding.mac : linux ? binding.linux : binding.win) ?? binding.key;
    if (!raw) return [];
    const parts = raw.split("-");
    const labels: Record<string, string> = {
      Mod: apple ? "⌘" : "Ctrl",
      Cmd: "⌘",
      Ctrl: apple ? "⌃" : "Ctrl",
      Alt: apple ? "⌥" : "Alt",
      Shift: apple ? "⇧" : "Shift",
      Escape: "Esc",
      ArrowLeft: "←",
      ArrowRight: "→",
      ArrowUp: "↑",
      ArrowDown: "↓",
      Space: "Space",
    };
    return parts.map((key) => labels[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  }
  return (apple ? entry.appleKeys : undefined) ?? entry.keys ?? [];
}

function searchable(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/⌘/g, " cmd ")
    .replace(/⌃/g, " ctrl ")
    .replace(/⌥/g, " alt ")
    .replace(/⇧/g, " shift ")
    .replace(/[+]/g, " ");
}

/** Match an action, owning screen, or key sequence, including either platform's modifier names. */
export function shortcutReferenceMatches(
  query: string,
  label: string,
  group: string,
  keys: readonly string[],
  aliases: readonly string[] = [],
): boolean {
  const haystack = searchable([label, group, ...keys, ...aliases].join(" "));
  return searchable(query)
    .trim()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/** A complete searchable reference, with separate views for live commands and personal preferences. */
export function ShortcutHelpSheet({
  open,
  commands,
  apple,
  onClose,
}: {
  open: boolean;
  commands: readonly RegisteredShortcut[];
  apple: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("shell.shortcuts");
  const allMessages = useTranslations();
  const tDate = useTranslations("shell.dateEntry");
  const tEntry = useTranslations("entry.keys");
  const [view, setView] = useState<"all" | "current" | "preferences">("all");
  const [query, setQuery] = useState("");
  const linux = /linux/i.test(currentPlatform());
  const reference = [
    ...SHORTCUT_REFERENCE_GROUPS,
    { id: "editor", entries: EDITOR_SHORTCUT_REFERENCE },
  ].map((group) => ({
    id: group.id,
    title: t(`reference.groups.${group.id}`),
    entries: group.entries.flatMap((entry) => {
      const keyCaps = referenceKeys(entry, apple, linux);
      if (!keyCaps.length) return [];
      const label = allMessages(
        entry.labelKey,
        entry.labelValueKey ? { direction: allMessages(entry.labelValueKey) } : undefined,
      );
      return [
        {
          id: entry.id,
          label,
          keys: keyCaps,
          separator: entry.separator,
          aliases: [...referenceKeys(entry, !apple), ...referenceKeys(entry, false, true)],
        },
      ];
    }),
  }));
  const current = SCOPE_ORDER.map((scope) => ({
    id: `current-${scope}`,
    title: t(`scopes.${scope}`),
    entries: commands
      .filter((command) => command.scope === scope)
      .map((command) => ({
        id: command.id,
        label: shortcutLabel(command),
        keys: bindingKeys(command.binding, apple),
        separator: undefined,
        aliases: bindingKeys(command.binding, !apple),
      })),
  }));
  const documented = new Set(
    reference.flatMap((group) =>
      group.entries.map((entry) => `${entry.label}|${entry.keys.join(" ")}`),
    ),
  );
  const extra = current.map((group) => ({
    ...group,
    entries: group.entries.filter(
      (entry) => !documented.has(`${entry.label}|${entry.keys.join(" ")}`),
    ),
  }));
  const groups = (view === "current" ? current : [...extra, ...reference])
    .map((group) => ({
      ...group,
      entries: group.entries.filter((entry) =>
        shortcutReferenceMatches(query, entry.label, group.title, entry.keys, entry.aliases),
      ),
    }))
    .filter((group) => group.entries.length > 0);
  const total = [...extra, ...reference].reduce((count, group) => count + group.entries.length, 0);
  const shown = groups.reduce((count, group) => count + group.entries.length, 0);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("title")}
      description={t("description")}
      size="lg"
      stacked
    >
      <div className="space-y-4">
        <RecordTabs
          label={t("title")}
          active={view}
          onChange={setView}
          tabs={[
            { key: "all", label: t("reference.all"), count: total },
            { key: "current", label: t("reference.current"), count: commands.length },
            { key: "preferences", label: tEntry("preferencesTitle") },
          ]}
        >
          {view === "preferences" ? (
            <EntryPreferencesPanel />
          ) : (
            <div className="space-y-4 pt-4">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t("reference.search")}
                placeholder={t("reference.search")}
                data-autofocus
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("reference.scopeHint")}
              </p>
              <p role="status" className="text-xs text-slate-500 dark:text-slate-400">
                {t("reference.count", { count: shown })}
              </p>
              {groups.length ? (
                <div className="grid items-start gap-x-8 gap-y-6 lg:grid-cols-2">
                  {groups.map((group) => (
                    <Group key={group.id} title={group.title}>
                      {group.entries.map((entry) => (
                        <Row key={entry.id} label={entry.label}>
                          <KeyCaps keys={entry.keys} separator={entry.separator} />
                        </Row>
                      ))}
                    </Group>
                  ))}
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-slate-500">{t("reference.empty")}</p>
              )}
              {view === "all" && !query ? (
                <div className="space-y-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  <p>{tDate("repeatHint")}</p>
                  <p>{tDate("typingHint")}</p>
                  <p>{tDate("calendarHint")}</p>
                </div>
              ) : null}
            </div>
          )}
        </RecordTabs>
      </div>
    </Drawer>
  );
}
