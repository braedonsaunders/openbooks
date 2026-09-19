import type { useTranslations } from 'next-intl'

export type WizardT = ReturnType<typeof useTranslations<'admin.setup.wizard'>>

/** One installable pack as the wizard needs it: the code, and its own name. */
export interface WizardPayrollPack {
  country: string
  name: string
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

export function packDescription(t: WizardT, code: string): string {
  const key = `payroll.packs.${code.toLowerCase()}.description`
  return t.has(key as never) ? t(key as never) : ''
}
