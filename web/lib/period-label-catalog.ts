import en from "../messages/en/periodLabels.json";
import de from "../messages/de/periodLabels.json";
import es from "../messages/es/periodLabels.json";
import fr from "../messages/fr/periodLabels.json";
import ja from "../messages/ja/periodLabels.json";
import ptBr from "../messages/pt-BR/periodLabels.json";
import zh from "../messages/zh/periodLabels.json";

/**
 * The period-window phrases and period preset names from the locale
 * catalogs (`periodLabels`), the one source for both: pickers read them
 * through next-intl, and presenters that label a report window from its
 * locale alone (report headers, column titles, exports, inside and outside a
 * request) read them here. Preset ids and the locale-free English labels in
 * the reports package stay the stable keys for URLs, logs and storage.
 */
type PeriodLabels = typeof en;

const CATALOGS: Record<string, PeriodLabels> = { en, de, es, fr, ja, "pt-BR": ptBr, zh };

function catalogFor(locale: string): PeriodLabels {
  return CATALOGS[locale] ?? CATALOGS[locale.split("-")[0]!] ?? en;
}

/** A window that runs only to the business day: "P05 FY2026 · May 2026 to date". */
export function periodToDateLabel(windowLabel: string, locale: string): string {
  return catalogFor(locale).toDate.replace("{label}", windowLabel);
}

/** A period preset's name ("Trailing 12 Months"), keyed by its stable id. */
export function periodPresetName(id: string, locale: string): string {
  const presets: Record<string, string> = catalogFor(locale).presets;
  return presets[id] ?? (en.presets as Record<string, string>)[id] ?? id;
}

/** A period preset group's heading ("Rolling"), keyed by its stable group id. */
export function periodPresetGroupName(group: string, locale: string): string {
  const groups: Record<string, string> = catalogFor(locale).groups;
  return groups[group] ?? (en.groups as Record<string, string>)[group] ?? group;
}
