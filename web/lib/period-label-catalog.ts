import en from '../messages/en/periodLabels.json'
import de from '../messages/de/periodLabels.json'
import es from '../messages/es/periodLabels.json'
import fr from '../messages/fr/periodLabels.json'
import ja from '../messages/ja/periodLabels.json'
import ptBr from '../messages/pt-BR/periodLabels.json'
import zh from '../messages/zh/periodLabels.json'

/**
 * The period-window phrases from the locale catalogs (`periodLabels`), for
 * presenters that label a report window from its locale alone: report
 * headers, column titles and exports run inside and outside a request, so
 * they read the catalog directly rather than through a request translator.
 */
type PeriodLabels = typeof en

const CATALOGS: Record<string, PeriodLabels> = { en, de, es, fr, ja, 'pt-BR': ptBr, zh }

function catalogFor(locale: string): PeriodLabels {
  return CATALOGS[locale] ?? CATALOGS[locale.split('-')[0]!] ?? en
}

/** A window that runs only to the business day: "P05 FY2026 · May 2026 to date". */
export function periodToDateLabel(windowLabel: string, locale: string): string {
  return catalogFor(locale).toDate.replace('{label}', windowLabel)
}

/** The ISO week from its Monday to the business day. */
export function weekToDateLabel(locale: string): string {
  return catalogFor(locale).weekToDate
}
