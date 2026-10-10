import type { useTranslations } from 'next-intl'

export type WizardT = ReturnType<typeof useTranslations<'admin.setup.wizard'>>

/** One installable pack as the wizard needs it: the code, its own name, and
 *  the declarations its chooser description is derived from. */
export interface WizardPayrollPack {
  country: string
  name: string
  statutoryComponents?: readonly string[]
  regions?: { known: number; supported: number }
  publishedTaxYears?: readonly number[]
}

/** How many component names the chooser lists before eliding the rest. */
const SUMMARY_COMPONENTS = 3

/** "2024–2026" for a contiguous run, "2024, 2026" otherwise. */
function taxYearSpan(years: readonly number[]): string {
  const sorted = [...new Set(years)].sort((a, b) => a - b)
  if (sorted.length === 0) return ''
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const contiguous = last - first === sorted.length - 1
  return sorted.length === 1 ? String(first) : contiguous ? `${first}–${last}` : sorted.join(', ')
}

/**
 * Preselect only what is derived: a sole installable pack. Otherwise nothing —
 * the wizard must not silently become any one country, and the operator
 * chooses (or leaves payroll pack-less to install later from Payroll setup).
 */
export function initialPayrollPack(packs: readonly WizardPayrollPack[]): string | null {
  return packs.length === 1 ? (packs[0]?.country ?? null) : null
}

/**
 * Display strings for a pack. The locale wins where a key exists for the pack's
 * lowercase code (`payroll.packs.canada.title`); otherwise the PACK'S OWN NAME
 * is used, and the bare code only if a caller has no pack to hand.
 *
 * The fallback used to be the code itself, on the reasoning that it is
 * "legible on day one, localizable later". With two packs that was true. With
 * twelve it meant the wizard offered "GB", "DE", "FR", "IE", "AU", "IT", "NL",
 * "ES", "SG" and "JP" next to "Canada" and "United States", because only CA
 * and US ever got their i18n keys written and nothing failed when the rest did
 * not. A country's name is data the pack already declares — see
 * PayrollCountryPack.name — so no surface needs to wait for a translation edit
 * to be readable.
 */
export function packTitle(t: WizardT, code: string, name?: string): string {
  const key = `payroll.packs.${code.toLowerCase()}.title`
  return t.has(key as never) ? t(key as never) : (name ?? code)
}

/**
 * The pack's subtitle. A locale description wins where one is written;
 * otherwise the subtitle is composed from the pack's own declarations — what
 * it calculates, its regional income-tax coverage and its published table
 * years — so every pack reads with equivalent depth. Empty only when a caller
 * has no declarations to hand.
 */
export function packDescription(t: WizardT, code: string, pack?: WizardPayrollPack): string {
  const key = `payroll.packs.${code.toLowerCase()}.description`
  if (t.has(key as never)) return t(key as never)
  const components = pack?.statutoryComponents ?? []
  const years = taxYearSpan(pack?.publishedTaxYears ?? [])
  if (components.length === 0 || !years) return ''
  const listed = components.slice(0, SUMMARY_COMPONENTS).join(', ')
    + (components.length > SUMMARY_COMPONENTS ? '…' : '')
  const regions = pack?.regions
  if (!regions || regions.known <= 1) {
    return t('payroll.packSummary.national' as never, { components: listed, years } as never)
  }
  return regions.supported >= regions.known
    ? t('payroll.packSummary.allRegions' as never, { components: listed, years, known: regions.known } as never)
    : t('payroll.packSummary.someRegions' as never, {
        components: listed,
        years,
        known: regions.known,
        supported: regions.supported,
      } as never)
}
