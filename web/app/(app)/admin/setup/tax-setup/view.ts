import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { supportedTaxCountries } from '@openbooks/engine/src/tax-pack-provisioning.ts'
import { grid, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import type { TaxSetupGuideProps } from './sections'

/**
 * Tax Setup — the top-level guided workspace for standing up indirect-tax
 * compliance, split into a loader and a spec.
 *
 * The body is one interactive client component (`TaxSetupGuide`: search
 * filtering, checkbox/select state, expand/collapse, and a provision fetch
 * flow plus toasts — all useState and browser-locale formatting a spec
 * cannot name), so it renders through a WHOLE-COMPONENT slot: the loader
 * resolves every prop the guide needs to presentation-ready data, and the
 * slot spreads that one object onto the same component. No org id, no
 * Authz, no actions travel through the spec —
 * the props are data, not capabilities. Country display names stay
 * client-side (`countryOptions(locale)` inside the component — browser-locale
 * formatting — so the loader passes the raw `SupportedCountry` records), and
 * the only server-formatted values are the two step-stat strings (ICU
 * plurals, resolved in the loader verbatim, exactly as the native page
 * evaluates them before handing them to `StepLink`).
 *
 * The loader copies the native page VERBATIM: the `admin.setup.manage`
 * gate, the four parallel queries, and the `JURISDICTION:` prefixing that
 * merges the two installed-code sources into one `installedCodes` array.
 */

export interface TaxSetupData {
  title: string
  subtitle: string
  guide: TaxSetupGuideProps
}

export async function loadTaxSetup(
  sp: Record<string, string | string[] | undefined>,
): Promise<TaxSetupData> {
  void sp
  const authz = await requirePermission('admin.setup.manage')
  const t = await getTranslations('admin.setup.taxSetup')
  const orgId = authz.user.orgId

  const [installed, installedJurisdictions, jurisdictions, registrations] = await Promise.all([
    db.execute<{ code: string }>(sql`select distinct code from tax_return_forms where org_id = ${orgId} and is_active`),
    db.execute<{ code: string }>(sql`
      select code from tax_jurisdictions
       where org_id = ${orgId} and is_active and level = 'state'
    `),
    db.execute<{ n: number }>(sql`select count(*)::int as n from tax_jurisdictions where org_id = ${orgId} and is_active`),
    db.execute<{ n: number }>(sql`select count(*)::int as n from tax_registrations where org_id = ${orgId} and is_active`),
  ])

  return {
    title: t('title'),
    subtitle: t('subtitle'),
    guide: {
      countries: supportedTaxCountries(),
      installedCodes: [
        ...installed.rows.map((r) => r.code),
        ...installedJurisdictions.rows.map((r) => `JURISDICTION:${r.code}`),
      ],
      step2Title: t('step2.title'),
      step2Description: t('step2.description'),
      step2Stat: t('step2.stat', { count: jurisdictions.rows[0]?.n ?? 0 }),
      step2Href: '/admin/setup/tax-jurisdictions',
      step2Cta: t('step2.cta'),
      step3Title: t('step3.title'),
      step3Description: t('step3.description'),
      step3Stat: t('step3.stat', { count: registrations.rows[0]?.n ?? 0 }),
      step3Href: '/admin/setup/tax-registrations',
      step3Cta: t('step3.cta'),
    },
  }
}

/**
 * The page owns its narrow centered column; the setup workspace shell sits
 * outside it. The header (h1 + subtitle) is loader-resolved strings the bare
 * `page-header` block cannot express with identical classes (the native h1
 * carries `text-xl font-semibold …`, not the PageHeader component), so both
 * live in the shared `tax-setup-header` chrome with the guide slot.
 */
export function taxSetupSpec(data: TaxSetupData): PageSpec {
  return page({
    route: '/admin/setup/tax-setup',
    // The setup workspace renders its own shell around every entity page;
    // wrapping it in a second page layout would nest the chrome. The native
    // page owns its outer `<div className="mx-auto max-w-5xl space-y-6 p-1">`,
    // so the spec places the same element — the payroll/[entity] precedent.
    layout: 'bare',
    header: [],
    body: [
      grid('mx-auto max-w-5xl space-y-6 p-1', [
        widgetBlock('tax-setup-header', {
          title: data.title,
          subtitle: data.subtitle,
        }),
        // The guide always renders — no presence flag. Both step links live
        // INSIDE the guide component (the native `TaxSetupGuide` owns steps
        // 2 and 3), so there is nothing for the spec to omit.
        widgetBlock('tax-setup-guide', { guide: data.guide }),
      ]),
    ],
  })
}
